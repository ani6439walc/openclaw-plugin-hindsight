/** Durable per-item retain outbox. Producers add files; the Gateway drains them. */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  openSync,
  closeSync,
  fsyncSync,
  chmodSync
} from "fs";
import { randomUUID, createHash } from "crypto";
import { dirname, join, resolve } from "path";

export interface QueuedRetainPayload {
  content: string;
  documentId?: string;
  context?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  operationId?: string;
  updateMode?: "replace" | "append";
}
export interface QueuedRetain extends QueuedRetainPayload {
  id: string;
  bankId: string;
  documentId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  createdOrder?: string;
}
export interface RetainQueueOptions {
  /** Legacy JSONL path; new entries live in the adjacent `<filePath>.d` directory. */
  filePath: string;
  maxAgeMs?: number;
}
export class RetainQueue {
  readonly directory: string;
  private readonly maxAgeMs: number;
  constructor(opts: RetainQueueOptions) {
    this.directory = resolve(opts.filePath + ".d");
    this.maxAgeMs = opts.maxAgeMs ?? -1;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.syncDirectory(dirname(this.directory));
    // Stable filenames let an interrupted migration resume without duplicating rows.
    if (existsSync(opts.filePath)) {
      for (const line of readFileSync(opts.filePath, "utf8").split("\n")) {
        let item: QueuedRetain;
        try {
          item = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          !item ||
          typeof item.id !== "string" ||
          typeof item.content !== "string" ||
          typeof item.bankId !== "string" ||
          typeof item.createdAt !== "string" ||
          !Number.isFinite(Date.parse(item.createdAt))
        )
          continue;
        if (!existsSync(this.path(item.id))) this.write(item);
      }
      // Keep the original (including malformed lines) for recovery.
      try {
        chmodSync(opts.filePath, 0o600);
        renameSync(
          opts.filePath,
          opts.filePath +
            (existsSync(opts.filePath + ".migrated")
              ? `.migrated-${randomUUID()}`
              : ".migrated")
        );
        this.syncDirectory(dirname(resolve(opts.filePath)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  enqueue(
    bankId: string,
    request: QueuedRetainPayload,
    metadata?: Record<string, unknown>
  ): string {
    const item: QueuedRetain = {
      ...request,
      id: randomUUID(),
      bankId,
      documentId: request.documentId || "conversation",
      metadata: metadata || request.metadata || {},
      createdAt: new Date().toISOString(),
      createdOrder: process.hrtime.bigint().toString().padStart(30, "0")
    };
    this.write(item);
    return item.id;
  }
  peek(limit = 50): QueuedRetain[] {
    return this.readAll()
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          (a.createdOrder ?? a.id).localeCompare(b.createdOrder ?? b.id)
      )
      .slice(0, limit);
  }
  remove(id: string): void {
    try {
      unlinkSync(this.path(id));
      this.syncDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  removeMany(ids: string[]): void {
    for (const id of ids) this.remove(id);
  }
  ensureOperationId(id: string, operationId: string): string {
    const item = JSON.parse(
      readFileSync(this.path(id), "utf8")
    ) as QueuedRetain;
    if (item.operationId) return item.operationId;
    item.operationId = operationId;
    this.write(item);
    return operationId;
  }
  size(): number {
    return this.readAll().length;
  }
  cleanup(): number {
    if (this.maxAgeMs < 0) return 0;
    const expired = this.readAll().filter(
      (item) => new Date(item.createdAt).getTime() < Date.now() - this.maxAgeMs
    );
    this.removeMany(expired.map((item) => item.id));
    return expired.length;
  }
  close(): void {}
  private path(id: string): string {
    return join(
      this.directory,
      createHash("sha256").update(id).digest("hex") + ".json"
    );
  }
  private readAll(): QueuedRetain[] {
    const items: QueuedRetain[] = [];
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".json")) continue;
      let raw: string;
      try {
        raw = readFileSync(join(this.directory, name), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      // A corrupt item remains on disk for recovery instead of blocking other items.
      try {
        const item = JSON.parse(raw);
        if (
          item &&
          typeof item.id === "string" &&
          typeof item.content === "string" &&
          typeof item.bankId === "string" &&
          typeof item.createdAt === "string" &&
          Number.isFinite(Date.parse(item.createdAt))
        )
          items.push(item);
      } catch {
        /* preserve the corrupt file */
      }
    }
    return items;
  }
  private write(item: QueuedRetain): void {
    const temporary = join(this.directory, randomUUID() + ".tmp");
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(item) + "\n", "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.path(item.id));
    // Persist the directory entry too, so a committed enqueue survives a crash.
    this.syncDirectory();
  }
  private syncDirectory(directory = this.directory): void {
    // Node cannot open directory handles on Windows. File fsync still runs;
    // POSIX directory errors must propagate rather than hide durability failures.
    if (process.platform === "win32") return;
    const dir = openSync(directory, "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
}
