import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { providerDisplayName, providerNotificationTitle } from "../shared/providerMetadata";

describe("provider metadata", () => {
  it("keeps notifications provider-specific", () => {
    assert.equal(providerDisplayName("codex"), "Codex");
    assert.equal(providerDisplayName("claude"), "Claude Code");
    assert.equal(providerNotificationTitle("codex"), "Codex 已完成");
    assert.equal(providerNotificationTitle("claude"), "Claude Code 已完成");
  });
});
