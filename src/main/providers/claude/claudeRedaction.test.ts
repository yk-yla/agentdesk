import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactClaudeValue } from "./claudeRedaction";

describe("Claude worker redaction", () => {
  it("removes nested credential fields and bounds large strings", () => {
    const value = redactClaudeValue({ authorization: "secret", nested: { apiKey: "key", text: "x".repeat(9_000) } }) as Record<string, unknown>;
    assert.equal(value.authorization, "[已脱敏]");
    assert.equal((value.nested as Record<string, unknown>).apiKey, "[已脱敏]");
    assert.ok(String((value.nested as Record<string, unknown>).text).length < 9_000);
  });
});

