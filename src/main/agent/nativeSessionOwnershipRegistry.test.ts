import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NativeSessionOwnershipRegistry } from "./nativeSessionOwnershipRegistry";

describe("NativeSessionOwnershipRegistry", () => {
  it("rejects a terminal owner while the workbench owns the native session", () => {
    const registry = new NativeSessionOwnershipRegistry();
    registry.claim("codex", "thread-1", "workbench-tab", "workbench");
    assert.throws(() => registry.assertAvailable("codex", "thread-1", "terminal-tab", "terminal"), /占用/);
    assert.equal(registry.owner("codex", "thread-1")?.mode, "workbench");
  });

  it("releases terminal ownership without affecting another provider", () => {
    const registry = new NativeSessionOwnershipRegistry();
    registry.claim("codex", "same-id", "terminal-codex", "terminal");
    registry.claim("claude", "same-id", "terminal-claude", "terminal");
    assert.throws(() => registry.claim("codex", "same-id", "workbench-codex", "workbench"), /占用/);
    registry.release("codex", "same-id", "terminal-codex", "terminal");
    registry.claim("codex", "same-id", "workbench-codex", "workbench");
    assert.equal(registry.owner("claude", "same-id")?.clientSessionId, "terminal-claude");
  });
});
