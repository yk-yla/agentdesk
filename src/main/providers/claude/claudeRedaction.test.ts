import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactClaudeMessage, redactClaudeValue } from "./claudeRedaction";

describe("Claude worker redaction", () => {
  it("removes nested credential fields and bounds large strings", () => {
    const value = redactClaudeValue({ authorization: "secret", nested: { apiKey: "key", text: "x".repeat(9_000) } }) as Record<string, unknown>;
    assert.equal(value.authorization, "[已脱敏]");
    assert.equal((value.nested as Record<string, unknown>).apiKey, "[已脱敏]");
    assert.ok(String((value.nested as Record<string, unknown>).text).length < 9_000);
  });

  it("keeps token usage numbers while removing token credentials", () => {
    const value = redactClaudeValue({
      totalTokens: 3_200,
      maxTokens: 200_000,
      usage: { input_tokens: 10, output_tokens: 20 },
      authToken: "auth-secret",
      access_token: "access-secret",
      token: "generic-secret",
    }) as Record<string, unknown>;
    assert.equal(value.totalTokens, 3_200);
    assert.equal(value.maxTokens, 200_000);
    assert.deepEqual(value.usage, { input_tokens: 10, output_tokens: 20 });
    assert.equal(value.authToken, "[已脱敏]");
    assert.equal(value.access_token, "[已脱敏]");
    assert.equal(value.token, "[已脱敏]");
  });

  it("keeps long assistant text blocks without relaxing other bounds", () => {
    const text = "审".repeat(13_623);
    const value = redactClaudeMessage({
      type: "message",
      payload: {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text }] },
        diagnostic: "x".repeat(9_000),
      },
    }) as Record<string, unknown>;
    const payload = value.payload as Record<string, unknown>;
    const message = payload.message as Record<string, unknown>;
    const block = (message.content as Array<Record<string, unknown>>)[0];
    assert.equal(block.text, text);
    assert.ok(String(payload.diagnostic).endsWith("[已截断]"));
  });
});

