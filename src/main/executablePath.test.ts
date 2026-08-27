import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { resolveExecutableFromPath } from "./executablePath";

describe("executable path resolution", () => {
  it("resolves a regular executable from the provided PATH", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-executable-"));
    try {
      const executable = path.join(directory, "tool.exe");
      writeFileSync(executable, "fixture");
      assert.equal(resolveExecutableFromPath("tool.exe", { Path: directory }), executable);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts executable aliases represented by filesystem links", (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-executable-alias-"));
    try {
      const target = path.join(directory, "target.exe");
      const alias = path.join(directory, "alias.exe");
      writeFileSync(target, "fixture");
      try {
        symlinkSync(target, alias, "file");
      } catch {
        context.skip("当前 Windows 用户没有创建符号链接的权限。");
        return;
      }
      assert.equal(resolveExecutableFromPath("alias.exe", { Path: directory }), alias);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
