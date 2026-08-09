import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeDesktopNotification } from "./desktopNotification";

describe("desktop notification input", () => {
  it("creates provider titles and bounds the session title", () => {
    assert.deepEqual(normalizeDesktopNotification({ sessionId: "s1", provider: "codex", sessionTitle: "Codex task" }), { sessionId: "s1", provider: "codex", title: "Codex 已完成", body: "Codex task" });
    assert.equal(normalizeDesktopNotification({ sessionId: "s2", provider: "claude", sessionTitle: "x".repeat(200) })?.title, "Claude Code 已完成");
    assert.equal(normalizeDesktopNotification({ sessionId: "s2", provider: "claude", sessionTitle: "x".repeat(200) })?.body?.length, 120);
  });

  it("rejects missing and forged providers", () => {
    assert.equal(normalizeDesktopNotification({ sessionId: "s", provider: "other", title: "forged" }), null);
    assert.equal(normalizeDesktopNotification({ provider: "codex" }), null);
  });
});

