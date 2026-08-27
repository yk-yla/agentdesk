import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync } from "node:fs";
import path from "node:path";

const SHARED_CODEX_HOME_FILES = ["config.toml", "auth.json"] as const;

export type CodexHomeLinkStatus = "created" | "linked" | "missing-source" | "occupied" | "error";

export interface CodexHomeLinkResult {
  fileName: typeof SHARED_CODEX_HOME_FILES[number];
  sourcePath: string;
  targetPath: string;
  status: CodexHomeLinkStatus;
  error?: string;
  backupPath?: string;
}

function comparablePath(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function inspectExistingLink(targetPath: string, sourcePath: string): CodexHomeLinkStatus {
  const stat = lstatSync(targetPath);
  if (!stat.isSymbolicLink()) return "occupied";
  const linkedPath = path.resolve(path.dirname(targetPath), readlinkSync(targetPath));
  return comparablePath(linkedPath) === comparablePath(sourcePath) ? "linked" : "occupied";
}

function pathEntryExists(filePath: string) {
  try { lstatSync(filePath); return true; } catch { return false; }
}

export function ensureCodexHomeLinks(globalHome: string, isolatedHome: string): CodexHomeLinkResult[] {
  mkdirSync(isolatedHome, { recursive: true });
  return SHARED_CODEX_HOME_FILES.map((fileName) => {
    const sourcePath = path.join(globalHome, fileName);
    const targetPath = path.join(isolatedHome, fileName);
    if (!existsSync(sourcePath)) return { fileName, sourcePath, targetPath, status: "missing-source" };

    try {
      const existing = inspectExistingLink(targetPath, sourcePath);
      if (existing === "linked") {
        return { fileName, sourcePath, targetPath, status: existing };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { fileName, sourcePath, targetPath, status: "error", error: error instanceof Error ? error.message : String(error) };
      }
    }

    let backupPath: string | undefined;
    try {
      if (pathEntryExists(targetPath)) {
        backupPath = `${targetPath}.backup-${Date.now()}`;
        renameSync(targetPath, backupPath);
      }
      symlinkSync(sourcePath, targetPath, "file");
      return { fileName, sourcePath, targetPath, status: "created", backupPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          return { fileName, sourcePath, targetPath, status: inspectExistingLink(targetPath, sourcePath) };
        } catch {
          // Fall through to the original creation error.
        }
      }
      if (backupPath && !pathEntryExists(targetPath)) {
        try { renameSync(backupPath, targetPath); } catch { /* Keep the recoverable backup in place. */ }
      }
      return { fileName, sourcePath, targetPath, status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  });
}
