import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { writeTextFileAtomic, writeTextFileAtomicAsync } from "./atomicFile";

describe("atomic text file writes", () => {
  it("replaces an existing file without leaving a temporary file", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-atomic-write-"));
    try {
      const target = path.join(directory, "preferences.json");
      writeFileSync(target, "old", "utf8");
      writeTextFileAtomic(target, "new");
      assert.equal(readFileSync(target, "utf8"), "new");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the old file and removes the temporary file when rename fails", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-atomic-failure-"));
    try {
      const target = path.join(directory, "preferences.json");
      let temporaryPath = "";
      writeFileSync(target, "old", "utf8");
      assert.throws(() => writeTextFileAtomic(target, "new", {
        write: (filePath, content) => {
          temporaryPath = filePath;
          writeFileSync(filePath, content, "utf8");
        },
        rename: () => { throw new Error("simulated rename failure"); },
        unlink: unlinkSync,
      }), /simulated rename failure/);
      assert.equal(readFileSync(target, "utf8"), "old");
      assert.equal(existsSync(temporaryPath), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not block the main thread on a transient Windows file lock", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-atomic-retry-"));
    try {
      const target = path.join(directory, "preferences.json");
      let attempts = 0;
      writeFileSync(target, "old", "utf8");
      assert.throws(() => writeTextFileAtomic(target, "new", {
        write: writeFileSync,
        rename: (source, destination) => {
          attempts += 1;
          const error = new Error("simulated Windows lock") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
        unlink: unlinkSync,
      }), /simulated Windows lock/);
      assert.equal(attempts, 1);
      assert.equal(readFileSync(target, "utf8"), "old");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retries transient Windows file locks asynchronously", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-atomic-async-retry-"));
    try {
      const target = path.join(directory, "preferences.json");
      let attempts = 0;
      writeFileSync(target, "old", "utf8");
      await writeTextFileAtomicAsync(target, "new", {
        write: writeFileSync,
        rename: (source, destination) => {
          attempts += 1;
          if (attempts < 4) {
            const error = new Error("simulated Windows lock") as NodeJS.ErrnoException;
            error.code = attempts === 1 ? "EPERM" : attempts === 2 ? "EACCES" : "EBUSY";
            throw error;
          }
          renameSync(source, destination);
        },
        unlink: unlinkSync,
      });
      assert.equal(attempts, 4);
      assert.equal(readFileSync(target, "utf8"), "new");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
