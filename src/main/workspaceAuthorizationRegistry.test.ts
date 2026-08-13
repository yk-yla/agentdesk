import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkspaceAuthorizationRegistry } from "./workspaceAuthorizationRegistry";

describe("WorkspaceAuthorizationRegistry", () => {
  it("keeps explicit workspaces while provider discoveries rotate within capacity", () => {
    const registry = new WorkspaceAuthorizationRegistry(3);
    registry.register("D:\\current", "explicit");
    registry.register("D:\\history-1", "provider");
    registry.register("D:\\history-2", "provider");
    registry.register("D:\\history-3", "provider");

    assert.equal(registry.has("D:\\current"), true);
    assert.equal(registry.has("D:\\history-1"), false);
    assert.deepEqual(registry.paths(), ["D:\\current", "D:\\history-2", "D:\\history-3"]);
  });

  it("does not downgrade an explicit authorization when rediscovered by a provider", () => {
    const registry = new WorkspaceAuthorizationRegistry(2);
    registry.register("D:\\current", "explicit");
    registry.register("D:\\current", "provider");
    registry.register("D:\\history-1", "provider");
    registry.register("D:\\history-2", "provider");

    assert.deepEqual(registry.paths(), ["D:\\current", "D:\\history-2"]);
  });
});
