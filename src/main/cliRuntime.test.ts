import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { detectCliRuntime, hasCliProcess } from "./cliRuntime";

describe("CLI runtime snapshot", () => {
  it("uses the command selected by PATH and records its install source once", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-cli-runtime-"));
    const nativeDir = path.join(directory, "native");
    const npmDir = path.join(directory, "npm");
    mkdirSync(nativeDir); mkdirSync(npmDir);
    writeFileSync(path.join(nativeDir, "codex.exe"), "fixture");
    writeFileSync(path.join(npmDir, "codex.cmd"), "fixture");
    try {
      const environment = { Path: `${nativeDir}${path.delimiter}${npmDir}`, PATHEXT: ".EXE;.CMD" };
      const snapshot = detectCliRuntime("codex", environment);
      assert.equal(snapshot.source, "native");
      assert.equal(snapshot.executablePath.toLowerCase(), path.join(nativeDir, "codex.exe").toLowerCase());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recognizes Codex and Claude processes without matching unrelated names", () => {
    assert.equal(hasCliProcess([{ pid: 1, parentPid: 0, name: "codex.exe", commandLine: '"C:\\Tools\\codex.exe" app-server' }], "codex"), true);
    assert.equal(hasCliProcess([{ pid: 2, parentPid: 0, name: "claude.exe", commandLine: '"C:\\Tools\\claude.exe"' }], "claude"), true);
    assert.equal(hasCliProcess([{ pid: 3, parentPid: 0, name: "node.exe", commandLine: "build-codex-report.js" }], "codex"), false);
  });

  it("classifies npm, winget, and explicit custom paths", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-cli-source-"));
    const npmDir = path.join(directory, "npm");
    const wingetDir = path.join(directory, "Microsoft", "WinGet", "Links");
    mkdirSync(npmDir, { recursive: true }); mkdirSync(wingetDir, { recursive: true });
    const codexShim = path.join(npmDir, "codex.cmd");
    const claudeExe = path.join(wingetDir, "claude.exe");
    writeFileSync(codexShim, "fixture"); writeFileSync(claudeExe, "fixture");
    try {
      assert.equal(detectCliRuntime("codex", { Path: npmDir, PATHEXT: ".EXE;.CMD" }).source, "npm");
      assert.equal(detectCliRuntime("claude", { Path: wingetDir, PATHEXT: ".EXE;.CMD" }).source, "winget");
      assert.equal(detectCliRuntime("codex", { CODEX_DESKTOP_CLI: codexShim, Path: "", PATHEXT: ".EXE;.CMD" }).source, "custom");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
