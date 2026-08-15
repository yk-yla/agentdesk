import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexRequestError, isCodexActiveWriterConflict } from "./inputQueue";

describe("Codex writer conflict detection", () => {
  it("recognizes the provider active-writer error", () => {
    assert.equal(isCodexActiveWriterConflict(new CodexRequestError({
      method: "resumeSession",
      message: "thread 01 already has an active writer",
    })), true);
  });

  it("does not classify unrelated failures as writer conflicts", () => {
    assert.equal(isCodexActiveWriterConflict(new Error("Codex app-server is not available.")), false);
  });
});
