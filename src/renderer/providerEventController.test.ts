import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEventEnvelope, AgentProvider } from "../shared/agentProtocol";
import { CODEX_CAPABILITIES, emptySession, type SessionState } from "./domain";
import { ProviderEventController } from "./providerEventController";

function event(type: string, payload: Record<string, unknown> = {}, overrides: Partial<AgentEventEnvelope> = {}): AgentEventEnvelope {
  return { provider: "codex", type, payload, receivedAt: 1, ...overrides };
}

function createHarness(initialSessions?: Record<string, SessionState>) {
  let sessions = initialSessions || { session: Object.assign(emptySession("session", "D:\\work"), { threadId: "thread", capabilities: { ...CODEX_CAPABILITIES } }) };
  const raw: Array<{ sessionId: string; type: string }> = [];
  const completed: Array<{ sessionId: string; status: string }> = [];
  const committed: Array<{ sessionId: string; clientId: string }> = [];
  const recovered: AgentProvider[] = [];
  const notifications: string[] = [];
  const providerModels: Array<{ provider: AgentProvider; ids: string[] }> = [];
  const openedWorkspaces: Array<{ workspace: string; provider?: AgentProvider }> = [];
  const rejectedStarts: string[] = [];
  const resolvedStarts: string[] = [];
  let frame: (() => void) | null = null;
  let frameRequests = 0;

  const controller = new ProviderEventController({
    state: {
      getSessions: () => sessions,
      updateSession: (sessionId, updater) => { if (sessions[sessionId]) sessions = { ...sessions, [sessionId]: updater(sessions[sessionId]) }; },
      updateSessions: (updater) => { sessions = updater(sessions); },
      getActiveSessionId: () => "session",
      getWorkspace: () => "D:\\work",
    },
    runtime: {
      lifecycle: {
        rejectStart: (sessionId) => { rejectedStarts.push(sessionId); },
        resolveLateStart: (sessionId, value, adopt) => { resolvedStarts.push(sessionId); adopt(value); return true; },
      },
      messages: {
        commitPendingSteer: (sessionId, clientId) => { committed.push({ sessionId, clientId }); },
        handleTurnCompleted: (sessionId, status) => { completed.push({ sessionId, status }); },
      },
      settings: {
        confirmed: (_sessionId, fallback) => fallback,
        hasPending: () => false,
        setConfirmed: () => undefined,
      },
    },
    services: {
      setReady: () => undefined,
      removeHistory: () => undefined,
      clearSession: () => undefined,
      recoverProvider: (provider) => { recovered.push(provider); },
      closeActiveTab: () => undefined,
      reloadSkills: () => undefined,
      activateSession: () => undefined,
      openWorkspace: (workspace, provider) => { openedWorkspaces.push({ workspace, provider }); },
      adoptStartedThread: () => "thread",
      loadSkills: () => undefined,
      updateProviderModels: (provider, models) => { providerModels.push({ provider, ids: models.map((model) => model.id) }); },
      rememberModelContextWindow: () => undefined,
      appendRawEvent: (sessionId, type) => { raw.push({ sessionId, type }); },
      showNotification: (session) => { notifications.push(session.id); },
      isDocumentFocused: () => true,
      requestFrame: (callback) => { frameRequests += 1; frame = callback; return frameRequests; },
      cancelFrame: () => { frame = null; },
      now: () => 1_000,
    },
  });
  controller.bindSession("codex", "thread", "session");

  return {
    controller,
    get sessions() { return sessions; },
    raw,
    completed,
    committed,
    recovered,
    notifications,
    providerModels,
    openedWorkspaces,
    rejectedStarts,
    resolvedStarts,
    get frame() { return frame; },
    get frameRequests() { return frameRequests; },
  };
}

describe("ProviderEventController", () => {
  it("commits lifecycle events immediately and advances both event versions", () => {
    const harness = createHarness();
    const before = harness.controller.captureVersion("session");

    harness.controller.handleEnvelope(event("turn/started", { threadId: "thread", turn: { id: "turn-1" } }));

    assert.equal(harness.sessions.session.status, "working");
    assert.equal(harness.sessions.session.activeTurnId, "turn-1");
    assert.deepEqual(harness.controller.changedSince("session", before), { preserveRealtime: true, preserveLifecycle: true });
    assert.equal(harness.raw.length, 1);
  });

  it("coalesces high-frequency events into one scheduled frame", () => {
    const harness = createHarness();

    harness.controller.handleEnvelope(event("item/agentMessage/delta", { threadId: "thread", itemId: "message", delta: "a" }));
    harness.controller.handleEnvelope(event("item/agentMessage/delta", { threadId: "thread", itemId: "message", delta: "b" }));

    assert.equal(harness.frameRequests, 1);
    assert.ok(harness.frame);
    assert.equal(harness.sessions.session.messages.length, 0);
    harness.controller.flush();
    assert.equal(harness.controller.captureVersion("session").event, 2);
  });

  it("ignores terminal side effects from an older Query generation", () => {
    const session = Object.assign(emptySession("session", "D:\\work"), {
      threadId: "thread",
      queryGeneration: 2,
      status: "working" as const,
      activeTurnId: "turn-2",
      capabilities: { ...CODEX_CAPABILITIES },
    });
    const harness = createHarness({ session });

    harness.controller.handleEnvelope(event("turn/completed", { threadId: "thread", turn: { id: "turn-1", status: "completed" } }, { queryGeneration: 1 }));

    assert.equal(harness.completed.length, 0);
    assert.equal(harness.raw.length, 0);
    assert.equal(harness.sessions.session.activeTurnId, "turn-2");
  });

  it("does not bind a direct client session owned by another Provider", () => {
    const codex = Object.assign(emptySession("codex-session", "D:\\work", "", "", "codex"), { threadId: "codex-thread", capabilities: { ...CODEX_CAPABILITIES } });
    const harness = createHarness({ "codex-session": codex });

    harness.controller.handleEnvelope(event("claude/turnCompleted", { nativeSessionId: "claude-thread", status: "completed" }, {
      provider: "claude",
      sessionId: "codex-session",
    }));

    assert.equal(harness.completed.length, 0);
    assert.equal(harness.raw.length, 0);
  });

  it("publishes the current Claude SDK model list for replacement and caching", () => {
    const session = Object.assign(emptySession("session", "D:\\work", "", "", "claude"), { threadId: "thread" });
    const harness = createHarness({ session });

    harness.controller.handleEnvelope(event("claude/capabilitiesUpdated", {
      nativeSessionId: "thread",
      capabilities: { models: "supported", effort: "supported" },
      models: [{ value: "sonnet", displayName: "Sonnet", supportedEffortLevels: ["medium"] }],
    }, { provider: "claude", sessionId: "session", queryGeneration: 1 }));

    assert.deepEqual(harness.providerModels, [{ provider: "claude", ids: ["sonnet"] }]);
  });

  it("holds an early thread start until the matching client session adopts it", () => {
    const session = Object.assign(emptySession("session", "D:\\work"), { capabilities: { ...CODEX_CAPABILITIES } });
    const harness = createHarness({ session });

    harness.controller.handleEnvelope(event("thread/started", { thread: { id: "early-thread" } }));
    const pending = harness.controller.takePendingStart("codex", "early-thread");

    assert.equal(pending?.kind, "sessionStarted");
    assert.equal(harness.controller.takePendingStart("codex", "early-thread"), undefined);
  });

  it("settles late session responses and disconnects only the exited Provider", () => {
    const harness = createHarness();

    harness.controller.handleEnvelope(event("client/late-response", {
      sessionId: "session",
      requestMethod: "thread/start",
      response: { result: { thread: { id: "thread" } } },
    }));
    harness.controller.handleEnvelope(event("client/server-exited"));

    assert.deepEqual(harness.resolvedStarts, ["session"]);
    assert.deepEqual(harness.recovered, ["codex"]);
  });

  it("passes a requested Provider when opening a workspace", () => {
    const harness = createHarness();

    harness.controller.handleEnvelope(event("client/open-workspace", { workspace: "D:\\target", provider: "claude" }));

    assert.deepEqual(harness.openedWorkspaces, [{ workspace: "D:\\target", provider: "claude" }]);
  });
});
