import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentBackend } from "./AgentBackend";
import type { AgentEventEnvelope, AgentProvider } from "../../shared/agentProtocol";
import { BackendManager } from "./BackendManager";

function backend(provider: AgentProvider, result: unknown): AgentBackend {
  const listeners = new Set<(event: AgentEventEnvelope) => void>();
  return {
    provider,
    request: async () => result,
    respondToInteraction: async () => undefined,
    subscribeEvents(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getCapabilities: async () => ({} as never),
    closeSession: async () => undefined,
    close: async () => undefined,
  };
}

describe("BackendManager", () => {
  it("routes requests only to the selected provider", async () => {
    const manager = new BackendManager();
    manager.register(backend("codex", "codex-result"));
    manager.register(backend("claude", "claude-result"));
    assert.equal(await manager.request("codex", "listModels"), "codex-result");
    assert.equal(await manager.request("claude", "listModels"), "claude-result");
  });

  it("rejects duplicate and unavailable providers", async () => {
    const manager = new BackendManager();
    manager.register(backend("codex", null));
    assert.throws(() => manager.register(backend("codex", null)), /Provider 已注册/);
    await assert.rejects(() => manager.request("claude", "listModels"), /Provider 暂不可用/);
  });

  it("treats closing an unregistered client session as already closed", async () => {
    const manager = new BackendManager();
    const codex = backend("codex", null);
    let closes = 0;
    codex.closeSession = async () => { closes += 1; };
    manager.register(codex);

    await manager.request("codex", "closeSession", {}, {
      sessionId: "missing-client",
      canonicalCwd: process.cwd(),
      nativeSessionId: "history-thread",
    });

    assert.equal(closes, 0);
  });

  it("closes every provider once and reports partial failures", async () => {
    const manager = new BackendManager();
    let codexCloses = 0;
    let claudeCloses = 0;
    const codex = backend("codex", null);
    codex.close = async () => { codexCloses += 1; };
    const claude = backend("claude", null);
    claude.close = async () => { claudeCloses += 1; throw new Error("worker close failed"); };
    manager.register(codex);
    manager.register(claude);
    const first = manager.close();
    const second = manager.close();
    await assert.rejects(first, /worker close failed/);
    await assert.rejects(second, /worker close failed/);
    assert.equal(codexCloses, 1);
    assert.equal(claudeCloses, 1);
  });
});
