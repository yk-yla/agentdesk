import { renameSync } from "node:fs";

export function quarantineCorruptFile(filePath: string, now = Date.now()): string | null | undefined {
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const backupPath = `${filePath}.corrupt=${now}${suffix ? `-${suffix}` : ""}`;
    try {
      renameSync(filePath, backupPath);
      return backupPath;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "";
      if (code === "EEXIST") continue;
      if (code === "ENOENT") return null;
      return undefined;
    }
  }
  return undefined;
}
