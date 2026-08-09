import { renameSync, unlinkSync, writeFileSync } from "node:fs";

interface AtomicFileOperations {
  write(filePath: string, content: string): void;
  rename(source: string, target: string): void;
  unlink(filePath: string): void;
}

const DEFAULT_OPERATIONS: AtomicFileOperations = {
  write: (filePath, content) => writeFileSync(filePath, content, "utf8"),
  rename: renameSync,
  unlink: unlinkSync,
};

const TRANSIENT_RENAME_ATTEMPTS = 12;
const MAX_TRANSIENT_RENAME_DELAY_MS = 200;

function isTransientRenameError(error: unknown) {
  return error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY");
}

function waitForRenameRetry(attempt: number) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, Math.min(10 * 2 ** (attempt - 1), MAX_TRANSIENT_RENAME_DELAY_MS));
}

export function writeTextFileAtomic(filePath: string, content: string, operations: AtomicFileOperations = DEFAULT_OPERATIONS) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  operations.write(temporaryPath, content);
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        operations.rename(temporaryPath, filePath);
        break;
      } catch (error) {
        if (!isTransientRenameError(error) || attempt >= TRANSIENT_RENAME_ATTEMPTS) throw error;
        waitForRenameRetry(attempt);
      }
    }
  } finally {
    try {
      operations.unlink(temporaryPath);
    } catch {
      // A successful rename already moved the temporary file.
    }
  }
}
