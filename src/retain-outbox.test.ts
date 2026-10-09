import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { HindsightClient } from "@vectorize-io/hindsight-client";
import { flushRetainQueue } from "./index.js";
import { RetainQueue } from "./retain-queue.js";

const tempDirs: string[] = [];

function makeQueuePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hindsight-retain-outbox-"));
  tempDirs.push(dir);
  return join(dir, "retains.jsonl");
}

function itemFilePath(filePath: string, id: string): string {
  const directory = `${filePath}.d`;
  const name = readdirSync(directory).find((candidate) => {
    return (
      JSON.parse(readFileSync(join(directory, candidate), "utf8")).id === id
    );
  });
  if (!name) throw new Error(`missing queued item: ${id}`);
  return join(directory, name);
}

function expectPrivateFile(path: string): void {
  // Windows permissions are governed by ACLs, not POSIX mode bits.
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("persistent retain outbox", () => {
  it("publishes complete private item files and recovers them in a new instance", () => {
    const filePath = makeQueuePath();
    const queue = new RetainQueue({ filePath });
    const id = queue.enqueue("bank-1", {
      content: "private conversation",
      documentId: "session-1",
      operationId: "operation-1",
      tags: ["discord"],
      metadata: { turn: 1 },
    });

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(readdirSync(`${filePath}.d`)).toHaveLength(1);
    expect(readdirSync(`${filePath}.d`)[0]).toMatch(/\.json$/);
    const itemPath = itemFilePath(filePath, id);
    expectPrivateFile(itemPath);
    expect(JSON.parse(readFileSync(itemPath, "utf8"))).toMatchObject({
      id,
      bankId: "bank-1",
      content: "private conversation",
      documentId: "session-1",
      operationId: "operation-1",
      tags: ["discord"],
      metadata: { turn: 1 },
    });
    queue.close();

    const recovered = new RetainQueue({ filePath });
    expect(recovered.size()).toBe(1);
    expect(recovered.peek()[0]).toMatchObject({
      id,
      content: "private conversation",
    });
  });

  it("makes independent producers observe additions and removals without overwriting another item", () => {
    const filePath = makeQueuePath();
    const producer = new RetainQueue({ filePath });
    const consumer = new RetainQueue({ filePath });
    const first = producer.enqueue("bank-1", { content: "first" });
    expect(consumer.size()).toBe(1);
    const second = consumer.enqueue("bank-2", { content: "second" });
    expect(producer.size()).toBe(2);

    consumer.remove(first);
    expect(producer.size()).toBe(1);
    expect(producer.peek()).toMatchObject([
      { id: second, bankId: "bank-2", content: "second" },
    ]);
    producer.remove(first);
    expect(consumer.size()).toBe(1);
    producer.remove(second);
    expect(consumer.size()).toBe(0);
  });

  it("preserves an item enqueued while a flush awaits an acknowledgement", async () => {
    const filePath = makeQueuePath();
    const consumer = new RetainQueue({ filePath });
    const producer = new RetainQueue({ filePath });
    const deliveredId = producer.enqueue("bank-1", {
      content: "already sending",
    });
    const deliveredPath = itemFilePath(filePath, deliveredId);
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const retain = vi.fn().mockImplementation(async () => {
      await acknowledgement;
      return {};
    });

    const flushing = flushRetainQueue(
      consumer,
      { retain } as unknown as HindsightClient,
      "supported",
    );
    expect(retain).toHaveBeenCalledTimes(1);
    const pendingId = producer.enqueue("bank-2", {
      content: "arrived during send",
    });
    acknowledge();
    await flushing;

    expect(producer.peek()).toMatchObject([
      { id: pendingId, content: "arrived during send" },
    ]);
    expect(consumer.size()).toBe(1);
    expect(existsSync(deliveredPath)).toBe(false);
    expect(new RetainQueue({ filePath }).peek()[0].id).toBe(pendingId);
  });

  it("persists the replay identity without changing other producer items", () => {
    const filePath = makeQueuePath();
    const consumer = new RetainQueue({ filePath });
    const producer = new RetainQueue({ filePath });
    const first = consumer.enqueue("bank-1", { content: "needs identity" });
    const second = producer.enqueue("bank-2", {
      content: "another producer",
      operationId: "other-id",
    });

    expect(consumer.ensureOperationId(first, "initial-id")).toBe("initial-id");
    const recovered = new RetainQueue({ filePath });
    expect(recovered.ensureOperationId(first, "replacement-id")).toBe(
      "initial-id",
    );
    expect(
      recovered.peek().find((item) => item.id === second)?.operationId,
    ).toBe("other-id");
    expect(recovered.size()).toBe(2);
    expectPrivateFile(itemFilePath(filePath, first));
  });

  it("migrates legacy JSONL once and preserves malformed rows in the archive", () => {
    const filePath = makeQueuePath();
    const legacy = {
      id: "legacy-1",
      bankId: "bank-1",
      content: "old queued conversation",
      documentId: "conversation",
      metadata: {},
      operationId: "legacy-operation",
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const original = `${JSON.stringify(legacy)}\nnot-json\n`;
    writeFileSync(filePath, original, { mode: 0o600 });

    const migrated = new RetainQueue({ filePath });
    expect(migrated.peek()).toEqual([legacy]);
    expect(existsSync(filePath)).toBe(false);
    expect(readFileSync(`${filePath}.migrated`, "utf8")).toBe(original);
    expectPrivateFile(`${filePath}.migrated`);
    expect(readdirSync(`${filePath}.d`)).toHaveLength(1);
    expectPrivateFile(join(`${filePath}.d`, readdirSync(`${filePath}.d`)[0]));

    migrated.remove(legacy.id);
    const recovered = new RetainQueue({ filePath });
    expect(recovered.size()).toBe(0);
    expect(readFileSync(`${filePath}.migrated`, "utf8")).toBe(original);
  });
  it("preserves invalid item files without blocking delivery of valid items", async () => {
    const filePath = makeQueuePath();
    const queue = new RetainQueue({ filePath });
    writeFileSync(
      join(queue.directory, "invalid.json"),
      JSON.stringify({ id: "broken", bankId: "bank", content: "missing date" }),
    );
    queue.enqueue("bank-1", { content: "valid" });
    const retain = vi.fn().mockResolvedValue({});
    await flushRetainQueue(
      queue,
      { retain } as unknown as HindsightClient,
      "supported",
    );
    expect(retain).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(0);
    expect(existsSync(join(queue.directory, "invalid.json"))).toBe(true);
  });

  it("prevents another worker from sending the same item while acknowledgement is pending", async () => {
    const filePath = makeQueuePath();
    const first = new RetainQueue({ filePath });
    const second = new RetainQueue({ filePath });
    first.enqueue("bank-1", { content: "send once" });
    let release!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retain = vi.fn().mockImplementation(async () => {
      await acknowledgement;
      return {};
    });
    const client = { retain } as unknown as HindsightClient;
    const pending = flushRetainQueue(first, client, "supported");
    try {
      await flushRetainQueue(second, client, "supported");
      expect(retain).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await pending;
    }
    expect(first.size()).toBe(0);
  });
});
