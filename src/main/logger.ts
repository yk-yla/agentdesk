import { createHash } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import type { JsonObject, LogEntry, LogLevel } from "../shared/protocol";

const LOG_FILE_PATTERN = /^agentdesk-(\d{4}-\d{2}-\d{2})\.ndjson$/;
const RETENTION_DAYS = 7;
const MAX_LOG_LINE_BYTES = 64 * 1024;
const MAX_STRING_LENGTH = 240;
const SENSITIVE_KEY = /(password|passwd|token|secret|authorization|credential|cookie|private.?key|api.?key|access.?key|data.?url)/i;
const USER_TEXT_KEY = /^(text|content|prompt|objective|description|body|input|query|name|title|preview|snippet)$/i;

export interface AppLogger {
  log(level: LogLevel, event: string, details?: unknown): void;
  flush(): Promise<void>;
  directory(): string;
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function textSummary(value: string) {
  return {
    kind: "text",
    length: value.length,
    sha256: createHash("sha256").update(value).digest("hex").slice(0, 16),
  };
}

function summarize(value: unknown, key = "", depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (SENSITIVE_KEY.test(key)) return { redacted: true, length: value.length };
    if (key === "arrayItem" || USER_TEXT_KEY.test(key) || value.length > MAX_STRING_LENGTH) return textSummary(value);
    return value;
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (depth >= 5) return { kind: "object", truncated: true };
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return { kind: "object", circular: true };
  seen.add(value);
  if (Array.isArray(value)) {
    return { count: value.length, items: value.slice(0, 20).map((item) => summarize(item, typeof item === "string" ? "arrayItem" : key, depth + 1, seen)) };
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record).slice(0, 100);
  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of entries) result[entryKey] = summarize(entryValue, entryKey, depth + 1, seen);
  if (Object.keys(record).length > entries.length) result._truncatedKeys = Object.keys(record).length - entries.length;
  seen.delete(value);
  return result;
}

export function summarizeForLog(value: unknown) {
  return summarize(value);
}

function errorDetails(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: truncate(error.stack || "", 4_000) };
  return { message: truncate(String(error), 2_000) };
}

export function logErrorDetails(error: unknown) {
  return errorDetails(error);
}

export class FileLogger implements AppLogger {
  private queue = Promise.resolve();
  private preparedDate = "";

  constructor(private readonly resolveDirectory: () => string, private readonly now: () => Date = () => new Date()) {}

  directory() {
    return this.resolveDirectory();
  }

  log(level: LogLevel, event: string, details?: unknown) {
    let currentTime: Date;
    let line: string;
    try {
      currentTime = this.now();
      const entry: LogEntry = {
        timestamp: currentTime.toISOString(),
        level,
        event: truncate(event || "unknown", 160),
        details: summarize(details) as JsonObject,
        processId: process.pid,
      };
      const serialized = JSON.stringify(entry);
      line = Buffer.byteLength(serialized, "utf8") <= MAX_LOG_LINE_BYTES
        ? `${serialized}\n`
        : `${JSON.stringify({ ...entry, details: { kind: "oversized", bytes: Buffer.byteLength(serialized, "utf8") } })}\n`;
    } catch {
      return;
    }
    this.queue = this.queue.then(async () => {
      try {
        const directory = this.resolveDirectory();
        await fsPromises.mkdir(directory, { recursive: true });
        const today = dateKey(currentTime);
        if (this.preparedDate !== today) {
          this.preparedDate = today;
          await this.prune(directory, today);
        }
        await fsPromises.appendFile(path.join(directory, `agentdesk-${today}.ndjson`), line, "utf8");
      } catch {
        // Logging must never break the desktop application.
      }
    });
  }

  flush() {
    return this.queue;
  }

  private async prune(directory: string, today: string) {
    const cutoff = new Date(`${today}T00:00:00.000Z`).getTime() - (RETENTION_DAYS - 1) * 24 * 60 * 60 * 1000;
    let names: string[] = [];
    try { names = await fsPromises.readdir(directory); } catch { return; }
    await Promise.all(names.map(async (name) => {
      const match = LOG_FILE_PATTERN.exec(name);
      if (!match) return;
      const timestamp = Date.parse(`${match[1]}T00:00:00.000Z`);
      if (Number.isFinite(timestamp) && timestamp < cutoff) await fsPromises.unlink(path.join(directory, name)).catch(() => undefined);
    }));
  }
}
