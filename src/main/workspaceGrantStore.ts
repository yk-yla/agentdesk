import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { writeTextFileAtomicAsync } from "./atomicFile";
import { quarantineCorruptFile } from "./corruptFile";

const MAX_WORKSPACE_GRANT_BYTES = 64 * 1024;

function uniquePaths(value: unknown, capacity: number) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 32_768) continue;
    const normalized = entry.trim();
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= capacity) break;
  }
  return result;
}

export class WorkspaceGrantStore {
  constructor(private readonly resolvePath: () => string, private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("工作区授权容量无效。");
  }

  private readFile() {
    const filePath = this.resolvePath();
    try {
      if (statSync(filePath).size > MAX_WORKSPACE_GRANT_BYTES) {
        return { paths: [], corrupt: true };
      }
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return { paths: [], corrupt: true };
      return { paths: uniquePaths(parsed, this.capacity), corrupt: false };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "";
      return { paths: [], corrupt: code !== "ENOENT" };
    }
  }

  read() {
    const result = this.readFile();
    if (result.corrupt) quarantineCorruptFile(this.resolvePath());
    return result.paths;
  }

  async grant(directory: string) {
    const result = this.readFile();
    if (result.corrupt) {
      quarantineCorruptFile(this.resolvePath());
      throw new Error("工作区授权文件损坏，已保留备份，请稍后重试。");
    }
    const next = uniquePaths([directory, ...result.paths], this.capacity);
    const filePath = this.resolvePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    await writeTextFileAtomicAsync(filePath, JSON.stringify(next, null, 2));
    return next;
  }
}
