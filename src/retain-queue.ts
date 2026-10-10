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
  chmodSync,
} from "fs";
import { readdir, readFile, rename, unlink } from "fs/promises";
import { randomUUID, createHash } from "crypto";
import { basename, dirname, join, resolve } from "path";

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
function parseQueuedRetain(raw: string): QueuedRetain | undefined {
  try {
    const item = JSON.parse(raw);
    if (
      item &&
      typeof item.id === "string" &&
      typeof item.content === "string" &&
      typeof item.bankId === "string" &&
      typeof item.createdAt === "string" &&
      Number.isFinite(Date.parse(item.createdAt)) &&
      (item.createdOrder === undefined ||
        (typeof item.createdOrder === "string" &&
          /^\d{30}$/.test(item.createdOrder)))
    )
      return item;
  } catch {
    /* preserve invalid data for recovery */
  }
  return undefined;
}
function compareQueuedRetains(a: QueuedRetain, b: QueuedRetain): number {
  return (
    a.createdAt.localeCompare(b.createdAt) ||
    (a.createdOrder ?? a.id).localeCompare(b.createdOrder ?? b.id)
  );
}

export class RetainQueue {
  readonly directory: string;
  private readonly maxAgeMs: number;
  private readonly files = new Map<string, string>();
  constructor(opts: RetainQueueOptions) {
    this.directory = resolve(opts.filePath + ".d");
    this.maxAgeMs = opts.maxAgeMs ?? -1;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.syncDirectory(dirname(this.directory));
    // Stable filenames let an interrupted migration resume without duplicating rows.
    if (existsSync(opts.filePath)) {
      for (const line of readFileSync(opts.filePath, "utf8").split("\n")) {
        const item = parseQueuedRetain(line);
        if (!item) continue;
        if (!existsSync(this.path(item.id))) this.write(item);
      }
      // Keep the original (including malformed lines) for recovery.
      try {
        if (process.platform !== "win32") chmodSync(opts.filePath, 0o600);
        renameSync(
          opts.filePath,
          opts.filePath +
            (existsSync(opts.filePath + ".migrated")
              ? `.migrated-${randomUUID()}`
              : ".migrated"),
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
    metadata?: Record<string, unknown>,
  ): string {
    const item: QueuedRetain = {
      ...request,
      id: randomUUID(),
      bankId,
      documentId: request.documentId || "conversation",
      metadata: metadata || request.metadata || {},
      createdAt: new Date().toISOString(),
      createdOrder: process.hrtime.bigint().toString().padStart(30, "0"),
    };
    this.write(item);
    return item.id;
  }
  peek(limit = 50): QueuedRetain[] {
    return this.readAll().sort(compareQueuedRetains).slice(0, limit);
  }
  /** One asynchronous snapshot per worker cycle; producers can keep adding files. */
  async batch(
    limit = 50,
    signal?: AbortSignal,
  ): Promise<{ items: QueuedRetain[]; pending: number }> {
    signal?.throwIfAborted();
    let names = (await readdir(this.directory)).filter((name) =>
      name.endsWith(".json"),
    );
    // One-time normalization preserves global FIFO for older hash-only files.
    // All I/O yields; subsequent cycles read only the selected payload batch.
    let normalized = false;
    for (let index = 0; index < names.length; index++) {
      signal?.throwIfAborted();
      const name = names[index];
      if (this.isOrderedName(name)) continue;
      const path = join(this.directory, name);
      try {
        const item = parseQueuedRetain(
          await readFile(path, { encoding: "utf8", signal }),
        );
        signal?.throwIfAborted();
        if (!item) {
          await rename(path, path + ".corrupt");
          names[index] = "";
        } else {
          const target = this.orderedPath(item);
          await rename(path, target);
          names[index] = basename(target);
        }
        normalized = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        names[index] = "";
      }
    }
    if (normalized) this.syncDirectory();
    names = names.filter(Boolean).sort();
    this.indexFiles(names);
    const items: QueuedRetain[] = [];
    let pending = names.length;
    const cutoff = this.maxAgeMs < 0 ? -Infinity : Date.now() - this.maxAgeMs;
    for (const name of names) {
      signal?.throwIfAborted();
      if (items.length >= limit) break;
      const path = join(this.directory, name);
      let raw: string;
      try {
        raw = await readFile(path, { encoding: "utf8", signal });
        signal?.throwIfAborted();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          pending--;
          continue;
        }
        throw error;
      }
      const item = parseQueuedRetain(raw);
      if (!item) {
        try {
          await rename(path, path + ".corrupt");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        pending--;
      } else {
        this.files.set(this.hash(item.id), path);
        if (Date.parse(item.createdAt) < cutoff) {
          try {
            await unlink(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          pending--;
        } else {
          items.push(item);
        }
      }
    }
    return { items: items.sort(compareQueuedRetains), pending };
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
  ensureOperationId(id: string, operationId: string): string | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.path(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const item = parseQueuedRetain(raw);
    if (!item) return undefined;
    if (item.operationId) return item.operationId;
    item.operationId = operationId;
    this.write(item);
    return operationId;
  }
  has(id: string): boolean {
    return existsSync(this.path(id));
  }
  /** Candidate count; malformed candidates are quarantined by the next scan. */
  size(): number {
    return readdirSync(this.directory).filter((name) => name.endsWith(".json"))
      .length;
  }
  cleanup(): number {
    if (this.maxAgeMs < 0) return 0;
    const expired = this.readAll().filter(
      (item) => new Date(item.createdAt).getTime() < Date.now() - this.maxAgeMs,
    );
    this.removeMany(expired.map((item) => item.id));
    return expired.length;
  }
  close(): void {}
  private hash(id: string): string {
    return createHash("sha256").update(id).digest("hex");
  }
  private orderedPath(item: QueuedRetain): string {
    return join(
      this.directory,
      `${String(Date.parse(item.createdAt)).padStart(16, "0")}-${item.createdOrder ?? "0".repeat(30)}-${this.hash(item.id)}.json`,
    );
  }
  private isOrderedName(name: string): boolean {
    return /^\d{16}-\d{30}-[a-f0-9]{64}\.json$/.test(name);
  }
  private indexFiles(names: string[]): void {
    this.files.clear();
    for (const name of names) {
      const hash = /([a-f0-9]{64})\.json$/.exec(name)?.[1];
      if (hash) this.files.set(hash, join(this.directory, name));
    }
  }
  private path(id: string): string {
    const hash = this.hash(id);
    let path = this.files.get(hash);
    if (!path) {
      this.indexFiles(readdirSync(this.directory));
      path = this.files.get(hash);
    }
    return path ?? join(this.directory, hash + ".json");
  }
  private readAll(): QueuedRetain[] {
    const items: QueuedRetain[] = [];
    const names = readdirSync(this.directory);
    this.indexFiles(names);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let raw: string;
      try {
        raw = readFileSync(join(this.directory, name), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const item = parseQueuedRetain(raw);
      if (item) {
        this.files.set(this.hash(item.id), join(this.directory, name));
        items.push(item);
      } else {
        const path = join(this.directory, name);
        try {
          renameSync(path, path + ".corrupt");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
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
    const hash = this.hash(item.id);
    const target = this.files.get(hash) ?? this.orderedPath(item);
    renameSync(temporary, target);
    this.files.set(hash, target);
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
