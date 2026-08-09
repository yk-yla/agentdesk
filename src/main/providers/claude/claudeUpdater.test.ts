import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { inspectAndExtractClaudeZip, inspectClaudeExecutable, isOfficialClaudeSignature, MAX_CLAUDE_BINARY_BYTES, normalizePowerShellError, type ClaudeSignatureInspection } from "./claudeUpdater";

const official: ClaudeSignatureInspection = {
  status: "Valid",
  signer: 'CN="Anthropic, PBC", O="Anthropic, PBC", L=San Francisco, S=California, C=US',
  issuer: 'CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1, O="DigiCert, Inc.", C=US',
  enhancedKeyUsages: ["1.3.6.1.5.5.7.3.3", "Code Signing"],
  chainStatus: [],
};

describe("Claude updater signature policy", () => {
  it("accepts only the exact Anthropic publisher with a valid code-signing chain", () => {
    assert.equal(isOfficialClaudeSignature(official), true);
    assert.equal(isOfficialClaudeSignature({ ...official, signer: 'CN="Other Anthropic Tools", O="Other"' }), false);
    assert.equal(isOfficialClaudeSignature({ ...official, enhancedKeyUsages: [] }), false);
    assert.equal(isOfficialClaudeSignature({ ...official, status: "NotSigned" }), false);
    assert.equal(isOfficialClaudeSignature({ ...official, status: "UnknownError" }), false);
    assert.equal(isOfficialClaudeSignature({ ...official, signer: "" }), false);
    assert.equal(isOfficialClaudeSignature({ ...official, signer: 'CN="Microsoft Windows", O="Microsoft Corporation"' }), false);
    assert.equal(isOfficialClaudeSignature({ ...official, chainStatus: ["UntrustedRoot"] }), false);
    assert.equal(isOfficialClaudeSignature({ ...official, chainStatus: ["NotTimeValid"] }), false);
  });

  it("allows the current Claude binary size and strips PowerShell presentation codes", () => {
    assert.ok(MAX_CLAUDE_BINARY_BYTES > 287 * 1024 * 1024);
    assert.equal(normalizePowerShellError("\u001b[31;1mException: \u001b[0mAGENTDESK_CLAUDE_BINARY_SIZE_INVALID\u001b[0m"), "AGENTDESK_CLAUDE_BINARY_SIZE_INVALID");
  });

  it("rejects a damaged ZIP before extracting an executable", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-claude-zip-"));
    const zipPath = path.join(directory, "claude.zip");
    try {
      writeFileSync(zipPath, "not a zip", "utf8");
      await assert.rejects(() => inspectAndExtractClaudeZip(zipPath, path.join(directory, "claude.exe")), /更新包无效或不完整/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an unsigned or non-Windows executable fixture", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-claude-exe-"));
    const executable = path.join(directory, "claude.exe");
    try {
      writeFileSync(executable, "MZ fixture", "utf8");
      const inspection = await inspectClaudeExecutable(executable);
      assert.equal(inspection.signatureValid, false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
