import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NativeSessionOwnershipRegistry } from "./nativeSessionOwnershipRegistry";

describe("NativeSessionOwnershipRegistry", () => {
  it("rejects a second owner while the workbench owns the native session", () => {
    const registry = new NativeSessionOwnershipRegistry();
    registry.claim("codex", "thread-1", "workbench-tab");
    assert.throws(() => registry.assertAvailable("codex", "thread-1", "second-tab"), /占用/);
  });

  it("releases ownership without affecting another provider", () => {
    const registry = new NativeSessionOwnershipRegistry();
    registry.claim("codex", "same-id", "codex-tab");
    registry.claim("claude", "same-id", "claude-tab");
    assert.throws(() => registry.claim("codex", "same-id", "second-codex"), /占用/);
    registry.release("codex", "same-id", "codex-tab");
    registry.claim("codex", "same-id", "workbench-codex");
    assert.equal(registry.owner("claude", "same-id")?.clientSessionId, "claude-tab");
  });
});
