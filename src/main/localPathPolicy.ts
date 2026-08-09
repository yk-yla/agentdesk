import { realpathSync } from "node:fs";
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

export function isWithinDirectory(filePath: string, directory: string) {
  const relative = path.relative(canonicalPath(directory), canonicalPath(filePath));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function isExecutableLocalPath(filePath: string) {
  return EXECUTABLE_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
