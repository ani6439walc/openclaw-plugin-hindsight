import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MoltbotPluginAPI, ServiceConfig } from "./types.js";
import { RetainQueue } from "./retain-queue.js";

let directory: string;
let queuePath: string;
let service: ServiceConfig;
let hook: Parameters<MoltbotPluginAPI["on"]>[1];
let flush: typeof import("./index.js").flushRetainQueue;
let Client: typeof import("@vectorize-io/hindsight-client").HindsightClient;
const ctx = {
  agentId: "main",
  sessionKey: "agent:main:discord:channel:test-channel",
  messageProvider: "discord",
};
const event = {
  success: true,
  messages: [
    {
      role: "user",
      content: "Remember that the project release is scheduled for Friday.",
    },
    {
      role: "assistant",
      content: "The project release is scheduled for Friday.",
    },
  ],
};
beforeEach(async () => {
  vi.resetModules();
  directory = mkdtempSync(join(tmpdir(), "hindsight-lazy-retain-"));
  queuePath = join(directory, "retains.jsonl");
  Client = (await import("@vectorize-io/hindsight-client")).HindsightClient;
  const module = await import("./index.js");
  flush = module.flushRetainQueue;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            api_version: "0.10.2",
            features: { store_document_text: true },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  module.default({
    config: {
      plugins: {
        entries: {
          hindsight: {
            config: {
              hindsightApiUrl: "http://localhost:8888",
              agentBankMap: { main: "test-bank" },
              dynamicBankId: true,
              autoRetain: true,
              retainEveryNTurns: 1,
              retainQueuePath: queuePath,
              logLevel: "off",
            },
          },
        },
      },
    },
    registerService: (registered) => {
      service = registered;
    },
    on: (name, handler) => {
      if (name === "agent_end") hook = handler;
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
});
afterEach(async () => {
  await service.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});
it("persists a Discord turn without services or a reachable API", async () => {
  const send = vi
    .spyOn(Client.prototype, "retain")
    .mockResolvedValue({} as never);
  vi.mocked(fetch).mockRejectedValue(new Error("API unavailable"));
  await hook(event, ctx);
  const rows = new RetainQueue({ filePath: queuePath }).peek();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual(
    expect.objectContaining({
      bankId: "test-bank",
      content: expect.stringContaining("Friday"),
      documentId: expect.stringContaining(`openclaw:${ctx.sessionKey}`),
      operationId: expect.any(String),
    }),
  );
  expect(send).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it("does not revive retention after service stop", async () => {
  await service.stop();
  await hook(event, ctx);
  expect(new RetainQueue({ filePath: queuePath }).size()).toBe(0);
});
it("delivers a scoped producer's persisted turn from the service with the same operation id", async () => {
  const send = vi
    .spyOn(Client.prototype, "retain")
    .mockResolvedValue({} as never);
  await hook(event, ctx);
  const queue = new RetainQueue({ filePath: queuePath });
  const item = queue.peek()[0];
  await service.start();
  await flush();
  expect(send).toHaveBeenCalledWith(
    "test-bank",
    item.content,
    expect.objectContaining({
      documentId: item.documentId,
      operationId: item.operationId,
      async: true,
    }),
  );
  expect(queue.size()).toBe(0);
});
it("retains the persisted turn when service initialization fails", async () => {
  await hook(event, ctx);
  vi.mocked(fetch).mockRejectedValue(new Error("API unavailable"));
  vi.useFakeTimers();
  const failed = expect(service.start()).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(10_000);
  await failed;
  expect(new RetainQueue({ filePath: queuePath }).size()).toBe(1);
});
