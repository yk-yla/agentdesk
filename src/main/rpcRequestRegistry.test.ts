import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RpcRequestRegistry } from "./rpcRequestRegistry";

describe("RPC request registry", () => {
  it("allows only the owning child to settle a pending request", () => {
    const registry = new RpcRequestRegistry<object>(8);
    const owner = {};
    const staleChild = {};
    registry.add(1, { child: owner, method: "model/list", resolve: () => undefined, reject: () => undefined }, 1_000, () => new Error("timeout"));
    assert.equal(registry.takeResponse(1, staleChild), null);
    assert.equal(registry.pendingCount, 1);
    assert.equal(registry.takeResponse(1, owner)?.kind, "pending");
    assert.equal(registry.pendingCount, 0);
  });

  it("records a timed out request as a late response for the same child", async () => {
    const registry = new RpcRequestRegistry<object>(8);
    const owner = {};
    const timedOut = new Promise<Error>((resolve) => {
      registry.add(2, { child: owner, method: "thread/start", sessionId: "session-1", resolve: () => undefined, reject: resolve }, 1, () => new Error("timeout"));
    });
    assert.match((await timedOut).message, /timeout/);
    assert.equal(registry.pendingCount, 0);
    assert.equal(registry.timedOutCount, 1);
    const late = registry.takeResponse(2, owner);
    assert.equal(late?.kind, "late");
    assert.equal(late?.request.sessionId, "session-1");
    assert.equal(registry.timedOutCount, 0);
  });

  it("rejects only requests owned by the exiting child", () => {
    const registry = new RpcRequestRegistry<object>(8);
    const firstChild = {};
    const secondChild = {};
    let firstError = "";
    let secondError = "";
    registry.add(3, { child: firstChild, method: "initialize", resolve: () => undefined, reject: (error) => { firstError = error.message; } }, 1_000, () => new Error("timeout"));
    registry.add(4, { child: secondChild, method: "model/list", resolve: () => undefined, reject: (error) => { secondError = error.message; } }, 1_000, () => new Error("timeout"));
    registry.reject(new Error("first exited"), firstChild);
    assert.equal(firstError, "first exited");
    assert.equal(secondError, "");
    assert.equal(registry.pendingCount, 1);
    assert.equal(registry.takeResponse(4, secondChild)?.kind, "pending");
  });

  it("bounds timed out request metadata", async () => {
    const registry = new RpcRequestRegistry<object>(1);
    const owner = {};
    const waitForTimeout = (id: number) => new Promise<void>((resolve) => {
      registry.add(id, { child: owner, method: "thread/read", resolve: () => undefined, reject: () => resolve() }, 1, () => new Error("timeout"));
    });
    await Promise.all([waitForTimeout(5), waitForTimeout(6)]);
    assert.equal(registry.timedOutCount, 1);
    assert.equal(registry.takeResponse(5, owner), null);
    assert.equal(registry.takeResponse(6, owner)?.kind, "late");
  });
});
