import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";

const SHARED_CODEX_HOME_FILES = ["config.toml", "auth.json"] as const;
const CODEX_SKILLS_DIRECTORY = "skills";
const SYSTEM_SKILLS_DIRECTORY = ".system";

export type CodexHomeLinkStatus = "created" | "linked" | "missing-source" | "occupied" | "error";

export interface CodexHomeLinkResult {
  fileName: typeof SHARED_CODEX_HOME_FILES[number];
  sourcePath: string;
  targetPath: string;
  status: CodexHomeLinkStatus;
  error?: string;
  backupPath?: string;
}

export type CodexSkillLinkStatus = "created" | "linked" | "missing-source" | "occupied" | "error";

export interface CodexSkillLinkResult {
  name: string;
  sourcePath: string;
  targetPath: string;
  status: CodexSkillLinkStatus;
  error?: string;
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

function inspectExistingDirectoryLink(targetPath: string, sourcePath: string): CodexSkillLinkStatus {
  const stat = lstatSync(targetPath);
  if (!stat.isSymbolicLink()) return "occupied";
  const linkedPath = path.resolve(path.dirname(targetPath), readlinkSync(targetPath));
  return comparablePath(linkedPath) === comparablePath(sourcePath) ? "linked" : "occupied";
}

function skillDirectories(skillsRoot: string) {
  if (!pathEntryExists(skillsRoot)) return [] as string[];
  try {
    return readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => {
        if (entry.name === SYSTEM_SKILLS_DIRECTORY) return false;
        try {
          // Windows Junctions report isDirectory() === false on Dirent; use
          // statSync so user skills linked from another provider are included.
          return statSync(path.join(skillsRoot, entry.name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((entry) => entry.name);
  } catch {
    return [] as string[];
  }
}

function removeStaleSkillLinks(sourceRoot: string, targetRoot: string, currentNames: ReadonlySet<string>) {
  try {
    for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
      if (entry.name === SYSTEM_SKILLS_DIRECTORY || currentNames.has(entry.name)) continue;
      const targetPath = path.join(targetRoot, entry.name);
      try {
        const stat = lstatSync(targetPath);
        if (!stat.isSymbolicLink()) continue;
        const linkedPath = path.resolve(path.dirname(targetPath), readlinkSync(targetPath));
        if (comparablePath(linkedPath) === comparablePath(path.join(sourceRoot, entry.name))) unlinkSync(targetPath);
      } catch {
        // A stale or concurrently removed link should not block other skills.
      }
    }
  } catch {
    // The target directory may be removed while the app is shutting down.
  }
}

/**
 * Projects user-level skills into AgentDesk's isolated Codex home.  The
 * projection keeps the app-server state isolated while allowing Codex to
 * discover the same user skills as a normal CLI session.  AgentDesk's own
 * system and plugin skill directories are intentionally left untouched.
 */
export function ensureCodexSkillLinks(globalHome: string, isolatedHome: string): CodexSkillLinkResult[] {
  const sourceRoot = path.join(globalHome, CODEX_SKILLS_DIRECTORY);
  const targetRoot = path.join(isolatedHome, CODEX_SKILLS_DIRECTORY);
  if (!pathEntryExists(sourceRoot)) {
    if (pathEntryExists(targetRoot)) removeStaleSkillLinks(sourceRoot, targetRoot, new Set());
    return [];
  }
  mkdirSync(targetRoot, { recursive: true });

  const names = skillDirectories(sourceRoot);
  const currentNames = new Set(names);
  removeStaleSkillLinks(sourceRoot, targetRoot, currentNames);
  return names.map((name) => {
    const sourcePath = path.join(sourceRoot, name);
    const targetPath = path.join(targetRoot, name);
    try {
      if (pathEntryExists(targetPath)) {
        return { name, sourcePath, targetPath, status: inspectExistingDirectoryLink(targetPath, sourcePath) };
      }
      symlinkSync(sourcePath, targetPath, process.platform === "win32" ? "junction" : "dir");
      return { name, sourcePath, targetPath, status: "created" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          return { name, sourcePath, targetPath, status: inspectExistingDirectoryLink(targetPath, sourcePath) };
        } catch {
          // Fall through to the original creation error.
        }
      }
      return { name, sourcePath, targetPath, status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  });
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
