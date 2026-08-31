import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const EXECUTABLE_FILE_EXTENSIONS = new Set([
  ".appref-ms", ".bat", ".chm", ".cmd", ".com", ".cpl", ".exe", ".hta", ".jar", ".js", ".jse",
  ".lnk", ".msi", ".msp", ".mst", ".ps1", ".psd1", ".psm1", ".py", ".pyw", ".reg", ".scf", ".scr",
  ".sh", ".url", ".vbe", ".vbs", ".wsf", ".wsh",
]);

export function canonicalPath(filePath: string) {
  try {
    return realpathSync(path.resolve(filePath));
  } catch {
    return path.resolve(filePath);
  }
}

export const canonicalWorkspace = canonicalPath;

export function isWithinDirectory(filePath: string, directory: string) {
  const relative = path.relative(canonicalPath(directory), canonicalPath(filePath));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function isExecutableLocalPath(filePath: string) {
  return EXECUTABLE_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Resolve a file supplied by an explicit paste/drop gesture before exposing it to a Provider. */
export function resolvePastedFilePath(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || /[\r\n]/.test(value)) throw new Error("粘贴文件路径无效。");
  const requestedPath = value.trim();
  if (requestedPath.length > 32_768 || !path.isAbsolute(requestedPath)) throw new Error("粘贴文件路径无效。");
  let stats;
  try {
    stats = lstatSync(requestedPath);
  } catch {
    throw new Error("粘贴文件不存在。");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("粘贴内容必须是普通文件。");
  const resolvedPath = canonicalPath(requestedPath);
  try {
    const resolvedStats = lstatSync(resolvedPath);
    if (resolvedStats.isSymbolicLink() || !resolvedStats.isFile()) throw new Error("粘贴内容必须是普通文件。");
  } catch (error) {
    if (error instanceof Error && error.message === "粘贴内容必须是普通文件。") throw error;
    throw new Error("粘贴文件不存在。");
  }
  return resolvedPath;
}

interface LocalPathAccessPolicy {
  isAuthorizedWorkspacePath(directory: string): boolean;
}

export function resolveLocalPathOpenRequest(input: unknown, policy: LocalPathAccessPolicy) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("本地文件链接无效。");
  const request = input as { path?: unknown; cwd?: unknown };
  if (typeof request.path !== "string" || !request.path.trim() || request.path.includes("\0")) throw new Error("本地文件链接无效。");

  const cwd = typeof request.cwd === "string" && request.cwd.trim() ? canonicalPath(request.cwd) : "";
  const requestedPath = request.path.trim();
  if (!path.isAbsolute(requestedPath) && (!cwd || !policy.isAuthorizedWorkspacePath(cwd))) {
    throw new Error("相对文件链接缺少已授权工作区。");
  }

  const resolveCandidate = (value: string) => canonicalPath(path.isAbsolute(value) ? value : path.resolve(cwd, value));
  let resolvedPath = resolveCandidate(requestedPath);
  if (!existsSync(resolvedPath)) {
    const location = /^(.*?):(\d+)(?::(\d+))?$/.exec(requestedPath);
    if (location?.[1]) resolvedPath = resolveCandidate(location[1]);
  }
  if (!existsSync(resolvedPath)) throw new Error("文件不存在。");

  const stats = statSync(resolvedPath);
  return {
    path: resolvedPath,
    revealOnly: stats.isFile() && isExecutableLocalPath(resolvedPath),
  };
}
