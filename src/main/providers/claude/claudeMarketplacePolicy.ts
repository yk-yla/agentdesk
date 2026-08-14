import { realpathSync, statSync } from "node:fs";
import path from "node:path";

function existingDirectory(value: string, missingMessage: string) {
  try {
    const resolved = realpathSync(value);
    if (!statSync(resolved).isDirectory()) throw new Error(missingMessage);
    return resolved;
  } catch (error) {
    if (error instanceof Error && error.message === missingMessage) throw error;
    throw new Error(missingMessage);
  }
}

/** Worker-side verification; the Renderer-provided source alone is never trusted. */
export function verifyWorkerLocalMarketplacePath(source: string, cwd: string, authorizedLocalMarketplacePath?: string) {
  const root = existingDirectory(cwd, "Claude 工作区不存在。");
  const resolved = existingDirectory(path.resolve(root, source), "Claude 本地插件市场不存在。");
  const relative = path.relative(root, resolved);
  const insideWorkspace = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (insideWorkspace) return resolved;
  const authorized = authorizedLocalMarketplacePath
    ? existingDirectory(authorizedLocalMarketplacePath, "Claude 本地插件市场授权路径不存在。")
    : "";
  if (!authorized || resolved !== authorized) throw new Error("Claude 本地插件市场未获得主进程授权。");
  return resolved;
}
