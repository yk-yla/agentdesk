import { existsSync, statSync } from "node:fs";
import path from "node:path";

function isFile(value: string) {
  try { return existsSync(value) && statSync(value).isFile(); } catch { return false; }
}

/** Resolves a command through PATH without depending on a machine-specific install directory. */
export function resolveExecutableFromPath(command: string) {
  const requested = command.trim();
  if (!requested) return "";
  if (isFile(requested)) return path.resolve(requested);
  const pathValue = process.env.Path || process.env.PATH || "";
  const extensions = path.extname(requested)
    ? [""]
    : (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${requested}${extension}`);
      if (isFile(candidate)) return path.resolve(candidate);
    }
  }
  return "";
}
