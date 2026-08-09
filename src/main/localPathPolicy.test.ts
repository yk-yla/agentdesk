import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { isExecutableLocalPath, isWithinDirectory } from "./localPathPolicy";

describe("local path policy", () => {
  it("accepts files inside a root and rejects traversal", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "codex-path-policy-"));
    try {
      const root = path.join(parent, "workspace");
      const outside = path.join(parent, "outside.png");
      mkdirSync(root);
      writeFileSync(path.join(root, "inside.png"), "inside");
      writeFileSync(outside, "outside");
      assert.equal(isWithinDirectory(path.join(root, "inside.png"), root), true);
      assert.equal(isWithinDirectory(path.join(root, "..", "outside.png"), root), false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects a directory link that escapes the allowed root", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "codex-path-link-"));
    try {
      const root = path.join(parent, "workspace");
      const outside = path.join(parent, "outside");
      const linked = path.join(root, "linked");
      mkdirSync(root);
      mkdirSync(outside);
      writeFileSync(path.join(outside, "secret.png"), "outside");
      symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
      assert.equal(isWithinDirectory(path.join(linked, "secret.png"), root), false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("recognizes executable local file types case-insensitively", () => {
    assert.equal(isExecutableLocalPath("C:\\work\\run.PS1"), true);
    assert.equal(isExecutableLocalPath("C:\\work\\notes.md"), false);
  });
});
