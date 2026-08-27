import { lstatSync } from "node:fs";
import path from "node:path";

function isExecutableEntry(value: string) {
  try {
    const stat = lstatSync(value);
    // Microsoft Store app execution aliases (for example wt.exe under
    // WindowsApps) are reparse-point links that cannot be followed by stat().
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Resolves a command through PATH without depending on a machine-specific install directory. */
export function resolveExecutableFromPath(command: string, environment: NodeJS.ProcessEnv = process.env) {
  const requested = command.trim();
  if (!requested) return "";
  if (isExecutableEntry(requested)) return path.resolve(requested);
  const pathValue = environment.Path || environment.PATH || "";
  const extensions = path.extname(requested)
    ? [""]
    : (environment.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${requested}${extension}`);
      if (isExecutableEntry(candidate)) return path.resolve(candidate);
    }
  }
  return "";
}
