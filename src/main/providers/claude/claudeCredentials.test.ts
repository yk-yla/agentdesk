import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLAUDE_PROCESS_CREDENTIAL_SOURCE, credentialEnv, parseClaudeCredentialFields, readClaudeCredentials } from "./claudeCredentials";

describe("Claude credentials", () => {
  it("creates a disposable environment without mutating process.env", () => {
    const before = process.env.ANTHROPIC_AUTH_TOKEN;
    const env = credentialEnv({ source: "settings", baseUrl: "https://example.invalid", authToken: "test-token" });
    assert.deepEqual(env, { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_AUTH_TOKEN: "test-token" });
    assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, before);
  });

  it("fails closed for missing, conflicting and unsafe credential fields", () => {
    assert.throws(() => parseClaudeCredentialFields({}, "settings"), /ANTHROPIC_BASE_URL/);
    assert.throws(() => parseClaudeCredentialFields({ ANTHROPIC_BASE_URL: "file:///tmp/key", ANTHROPIC_AUTH_TOKEN: "secret" }, "settings"), /HTTP\(S\)/);
    assert.throws(() => parseClaudeCredentialFields({ ANTHROPIC_BASE_URL: "https://user:pass@example.invalid", ANTHROPIC_AUTH_TOKEN: "secret" }, "settings"), /无用户信息/);
    assert.throws(() => parseClaudeCredentialFields({ ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_AUTH_TOKEN: "a", ANTHROPIC_API_KEY: "b" }, "settings"), /凭据冲突/);
    assert.throws(() => parseClaudeCredentialFields({ ANTHROPIC_BASE_URL: "https://example.invalid" }, "process"), /缺少 ANTHROPIC_AUTH_TOKEN/);
  });

  it("normalizes a valid HTTPS endpoint without exposing its token in errors", () => {
    const snapshot = parseClaudeCredentialFields({ ANTHROPIC_BASE_URL: "https://example.invalid/", ANTHROPIC_AUTH_TOKEN: "top-secret" }, "settings");
    assert.equal(snapshot.baseUrl, "https://example.invalid");
    assert.equal(snapshot.authToken, "top-secret");
  });

  it("uses process credentials only after an explicit controlled fallback", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agentdesk-credentials-"));
    try {
      const missing = path.join(root, "missing-settings.json");
      const processEnv = {
        ANTHROPIC_BASE_URL: "https://example.invalid",
        ANTHROPIC_AUTH_TOKEN: "process-secret",
      };
      assert.throws(() => readClaudeCredentials({ settingsFile: missing, processEnv }), new RegExp(CLAUDE_PROCESS_CREDENTIAL_SOURCE));
      assert.equal(readClaudeCredentials({ settingsFile: missing, processEnv, allowProcessFallback: true }).source, "process");
      assert.equal(readClaudeCredentials({ settingsFile: missing, processEnv: { ...processEnv, [CLAUDE_PROCESS_CREDENTIAL_SOURCE]: "process" } }).source, "process");

      const broken = path.join(root, "settings.json");
      writeFileSync(broken, "{not-json");
      assert.throws(() => readClaudeCredentials({ settingsFile: broken, processEnv, allowProcessFallback: true }), /无法读取或不是有效 JSON/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
