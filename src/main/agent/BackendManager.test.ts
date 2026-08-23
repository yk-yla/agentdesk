import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentBackend } from "./AgentBackend";
import type { AgentEventEnvelope, AgentProvider } from "../../shared/agentProtocol";
import { BackendManager } from "./BackendManager";
import { NativeSessionOwnershipRegistry } from "./nativeSessionOwnershipRegistry";

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

  it("releases renderer-owned sessions before a renderer reload", async () => {
    const manager = new BackendManager();
    const codex = backend("codex", { thread: { id: "thread-1", cwd: process.cwd() } });
    let closes = 0;
    codex.closeSession = async () => { closes += 1; };
    manager.register(codex);
    const context = { sessionId: "client-1", canonicalCwd: process.cwd(), queryGeneration: 0 };

    await manager.request("codex", "startSession", { cwd: process.cwd() }, context);
    assert.deepEqual(await manager.resetRendererSessions(), { reset: 1, failures: 0 });
    await manager.request("codex", "startSession", { cwd: process.cwd() }, context);

    assert.equal(closes, 1);
  });

  it("prepares a terminal only for a Provider-listed native session", async () => {
    const manager = new BackendManager();
    const codex = backend("codex", { data: [{ id: "thread-1", cwd: process.cwd() }] });
    let prepared = 0;
    codex.prepareTerminalSession = async () => { prepared += 1; };
    manager.register(codex);
    await manager.request("codex", "listSessions", { cwd: process.cwd() }, { canonicalCwd: process.cwd() });

    await manager.prepareTerminalSession("codex", { sessionId: "client-1", nativeSessionId: "thread-1", canonicalCwd: process.cwd() });
    await assert.rejects(
      () => manager.prepareTerminalSession("codex", { sessionId: "client-2", nativeSessionId: "unknown", canonicalCwd: process.cwd() }),
      /尚未由当前工作区/,
    );
    assert.equal(prepared, 1);
  });

  it("releases only the handoff tab while retaining other workbench bindings", async () => {
    const ownership = new NativeSessionOwnershipRegistry();
    const manager = new BackendManager(undefined, () => true, ownership);
    const codex = backend("codex", null);
    codex.request = async (operation, params) => operation === "listSessions"
      ? { data: [{ id: "thread-target", cwd: process.cwd() }, { id: "thread-other", cwd: process.cwd() }] }
      : { thread: { id: typeof params.threadId === "string" ? params.threadId : "thread-other", cwd: process.cwd() } };
    codex.prepareTerminalSession = async () => undefined;
    manager.register(codex);
    await manager.request("codex", "listSessions", { cwd: process.cwd() }, { canonicalCwd: process.cwd() });
    await manager.request("codex", "resumeSession", { cwd: process.cwd(), threadId: "thread-other" }, { sessionId: "other", canonicalCwd: process.cwd(), nativeSessionId: "thread-other" });
    await manager.request("codex", "resumeSession", { cwd: process.cwd(), threadId: "thread-target" }, { sessionId: "target", canonicalCwd: process.cwd(), nativeSessionId: "thread-target" });

    await manager.prepareTerminalSession("codex", { sessionId: "target", nativeSessionId: "thread-target", canonicalCwd: process.cwd() });

    assert.equal(ownership.owner("codex", "thread-other")?.clientSessionId, "other");
    assert.equal(ownership.owner("codex", "thread-target"), undefined);
    manager.assertNativeSessionAuthorized("codex", "thread-target", process.cwd());
  });

  it("blocks a terminal handoff while another Provider query is active", async () => {
    let emit: ((event: AgentEventEnvelope) => void) | undefined;
    const manager = new BackendManager();
    const codex = backend("codex", { thread: { id: "thread-running", cwd: process.cwd() } });
    codex.subscribeEvents = (listener) => { emit = listener; return () => undefined; };
    codex.prepareTerminalSession = async () => undefined;
    manager.register(codex);
    const context = { sessionId: "running", canonicalCwd: process.cwd(), nativeSessionId: "thread-running" };
    await manager.request("codex", "resumeSession", { cwd: process.cwd(), threadId: "thread-running" }, context);
    emit?.({ provider: "codex", type: "turn/started", receivedAt: Date.now(), payload: { threadId: "thread-running" } });

    await assert.rejects(() => manager.prepareTerminalSession("codex", context), /任务正在运行/);
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
