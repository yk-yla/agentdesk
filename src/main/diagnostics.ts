import { createHash } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import path from "node:path";

const LOG_FILE_PATTERN = /^agentdesk-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.ndjson$/;
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const SENSITIVE_KEY = /(password|passwd|token|secret|authorization|credential|cookie|private.?key|api.?key|access.?key|data.?url)/i;
const PATH_KEY = /^(workspace|cwd|path|filePath|defaultPath|directory)$/i;
const USER_TEXT_KEY = /^(text|content|prompt|objective|description|body|input|query|name|title|preview|snippet|delta|output|stdout|stderr|command|message)$/i;

function textSummary(value: string) {
  return { kind: "text", length: value.length, sha256: createHash("sha256").update(value).digest("hex").slice(0, 16) };
}

function pathSummary(value: string) {
  return {
    kind: "path",
    basename: value.replace(/^.*[\\/]/, ""),
    sha256: createHash("sha256").update(value).digest("hex").slice(0, 16),
  };
}

function sanitize(value: unknown, key = "", depth = 0): unknown {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (SENSITIVE_KEY.test(key)) return { redacted: true, length: value.length };
    if (PATH_KEY.test(key)) return pathSummary(value);
    if (USER_TEXT_KEY.test(key) || value.length > 240) return textSummary(value);
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") {
        url.username = "";
        url.password = "";
        for (const queryKey of [...url.searchParams.keys()]) if (/(token|secret|key|password|credential|authorization|auth)/i.test(queryKey)) url.searchParams.set(queryKey, "[redacted]");
        return url.toString();
      }
    } catch { /* Not a URL. */ }
    return value;
  }
  if (depth >= 6) return { kind: "object", truncated: true };
  if (Array.isArray(value)) return { count: value.length, items: value.slice(0, 30).map((item) => sanitize(item, "arrayItem", depth + 1)) };
  if (typeof value !== "object") return String(value);
  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>).slice(0, 120)) result[entryKey] = sanitize(entryValue, entryKey, depth + 1);
  return result;
}

async function recentLogLines(directory: string) {
  const names = (await fsPromises.readdir(directory).catch(() => []))
    .filter((name) => LOG_FILE_PATTERN.test(name))
    .sort((left, right) => {
      const leftMatch = /^agentdesk-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.ndjson$/.exec(left);
      const rightMatch = /^agentdesk-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.ndjson$/.exec(right);
      if (!leftMatch || !rightMatch) return 0;
      const dateOrder = rightMatch[1].localeCompare(leftMatch[1]);
      return dateOrder || Number(rightMatch[2] || 0) - Number(leftMatch[2] || 0);
    });
  const lines: string[] = [];
  let bytes = 0;
  for (const name of names) {
    if (bytes >= MAX_EXPORT_BYTES) break;
    const content = await fsPromises.readFile(path.join(directory, name), "utf8").catch(() => "");
    const chunk = content.slice(Math.max(0, content.length - (MAX_EXPORT_BYTES - bytes)));
    bytes += Buffer.byteLength(chunk, "utf8");
    lines.unshift(...chunk.split(/\r?\n/).filter(Boolean));
  }
  return lines.slice(-50_000);
}

export async function buildDiagnosticBundle(directory: string, metadata: Record<string, unknown>) {
  const logs = (await recentLogLines(directory)).flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return [{
        timestamp: parsed.timestamp,
        level: parsed.level,
        event: parsed.event,
        processId: parsed.processId,
        appRunId: parsed.appRunId,
        details: sanitize(parsed.details, "details"),
      }];
    } catch {
      return [];
    }
  });
  return JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), metadata: sanitize(metadata), logs }, null, 2);
}
