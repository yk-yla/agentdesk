import { rename, renameSync, unlink, unlinkSync, writeFile, writeFileSync } from "node:fs";

interface SyncAtomicFileOperations {
  write(filePath: string, content: string): void;
  rename(source: string, target: string): void;
  unlink(filePath: string): void;
}

interface AtomicFileOperations {
  write(filePath: string, content: string): void | Promise<void>;
  rename(source: string, target: string): void | Promise<void>;
  unlink(filePath: string): void | Promise<void>;
}

const DEFAULT_OPERATIONS: SyncAtomicFileOperations = {
  write: (filePath, content) => writeFileSync(filePath, content, "utf8"),
  rename: renameSync,
  unlink: unlinkSync,
};

const ASYNC_OPERATIONS: AtomicFileOperations = {
  write: (filePath, content) => new Promise<void>((resolve, reject) => writeFile(filePath, content, "utf8", (error) => error ? reject(error) : resolve())),
  rename: (source, target) => new Promise<void>((resolve, reject) => rename(source, target, (error) => error ? reject(error) : resolve())),
  unlink: (filePath) => new Promise<void>((resolve, reject) => unlink(filePath, (error) => error ? reject(error) : resolve())),
};

const TRANSIENT_RENAME_ATTEMPTS = 12;
const MAX_TRANSIENT_RENAME_DELAY_MS = 200;

function isTransientRenameError(error: unknown) {
  return error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY");
}

function waitForRenameRetry(attempt: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.min(10 * 2 ** (attempt - 1), MAX_TRANSIENT_RENAME_DELAY_MS)));
}

export function writeTextFileAtomic(filePath: string, content: string, operations: SyncAtomicFileOperations = DEFAULT_OPERATIONS) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  operations.write(temporaryPath, content);
  try {
    operations.rename(temporaryPath, filePath);
  } finally {
    try {
      operations.unlink(temporaryPath);
    } catch {
      // A successful rename already moved the temporary file.
    }
  }
}

export async function writeTextFileAtomicAsync(filePath: string, content: string, operations: AtomicFileOperations = ASYNC_OPERATIONS) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await operations.write(temporaryPath, content);
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await operations.rename(temporaryPath, filePath);
        break;
      } catch (error) {
        if (!isTransientRenameError(error) || attempt >= TRANSIENT_RENAME_ATTEMPTS) throw error;
        await waitForRenameRetry(attempt);
      }
    }
  } finally {
    try {
      await operations.unlink(temporaryPath);
    } catch {
      // A successful rename already moved the temporary file.
    }
  }
}
