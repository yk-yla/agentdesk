import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEventEnvelope, AgentProvider } from "../shared/agentProtocol";
import { asRecord, CODEX_CAPABILITIES, emptySession, stringValue, type SessionState } from "./domain";
import { routeAgentEvent } from "./agent/AgentEventRouter";
import { coalesceBatchedProviderEvents, ProviderEventController } from "./providerEventController";

function event(type: string, payload: Record<string, unknown> = {}, overrides: Partial<AgentEventEnvelope> = {}): AgentEventEnvelope {
  return { provider: "codex", type, payload, receivedAt: 1, ...overrides };
}

function createHarness(initialSessions?: Record<string, SessionState>) {
  let sessions = initialSessions || { session: Object.assign(emptySession("session", "D:\\work"), { threadId: "thread", capabilities: { ...CODEX_CAPABILITIES } }) };
  const raw: Array<{ sessionId: string; type: string }> = [];
  const completed: Array<{ sessionId: string; status: string }> = [];
  const committed: Array<{ sessionId: string; clientId: string }> = [];
  const recovered: AgentProvider[] = [];
  const recoveredSessionIds: Array<string | undefined> = [];
  const notifications: string[] = [];
  const providerModels: Array<{ provider: AgentProvider; ids: string[] }> = [];
  const openedWorkspaces: Array<{ workspace: string; provider?: AgentProvider }> = [];
  const rejectedStarts: string[] = [];
  const resolvedStarts: string[] = [];
  const rememberedCompactions: string[] = [];
  const titleRefreshes: Array<{ sessionId: string; status: string }> = [];
  const skillReloadProviders: AgentProvider[] = [];
  const activatedSessions: string[] = [];
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
      recoverProvider: (provider, sessionId) => { recovered.push(provider); recoveredSessionIds.push(sessionId); },
      closeActiveTab: () => undefined,
      reloadSkills: (provider) => { skillReloadProviders.push(provider); },
      activateSession: (sessionId) => { activatedSessions.push(sessionId); },
      openWorkspace: (workspace, provider) => { openedWorkspaces.push({ workspace, provider }); },
      adoptStartedThread: () => "thread",
      loadSkills: () => undefined,
      updateProviderModels: (provider, models) => { providerModels.push({ provider, ids: models.map((model) => model.id) }); },
      rememberModelContextWindow: () => undefined,
      rememberCompaction: (_sessionId, routed) => { rememberedCompactions.push(routed.nativeSessionId || ""); },
      refreshSessionTitle: (sessionId, status) => { titleRefreshes.push({ sessionId, status }); },
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
    recoveredSessionIds,
    notifications,
    providerModels,
    openedWorkspaces,
    rejectedStarts,
    resolvedStarts,
    rememberedCompactions,
    titleRefreshes,
    skillReloadProviders,
    activatedSessions,
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
  it("concatenates adjacent Codex and Claude text deltas before applying them", () => {
    const codex = coalesceBatchedProviderEvents([
      { sessionId: "session", event: routeAgentEvent(event("item/agentMessage/delta", { threadId: "thread", itemId: "message", delta: "a" })) },
      { sessionId: "session", event: routeAgentEvent(event("item/agentMessage/delta", { threadId: "thread", itemId: "message", delta: "b" })) },
    ]);
    const claudeEnvelope = (text: string): AgentEventEnvelope => event("claude/sdkMessage", {
      type: "stream_event",
      nativeSessionId: "thread",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    }, { provider: "claude" });
    const claude = coalesceBatchedProviderEvents([
      { sessionId: "session", event: routeAgentEvent(claudeEnvelope("甲")) },
      { sessionId: "session", event: routeAgentEvent(claudeEnvelope("乙")) },
    ]);

    assert.equal(codex.length, 1);
    const codexPayload = asRecord(codex[0].event.envelope.payload);
    assert.equal(stringValue(codexPayload.delta), "ab");
    assert.equal(claude.length, 1);
    const claudePayload = asRecord(claude[0].event.envelope.payload);
    const stream = asRecord(claudePayload.event);
    const delta = asRecord(stream.delta);
    assert.equal(stringValue(delta.text), "甲乙");
  });


  it("persists completed Codex compactions through the event service", () => {
    const harness = createHarness();

    harness.controller.handleEnvelope(event("item/completed", {
      threadId: "thread",
      item: { id: "compact-1", type: "contextCompaction" },
    }));

    assert.deepEqual(harness.rememberedCompactions, ["thread"]);
    assert.equal(harness.sessions.session.compactionCount, 1);
  });

  it("persists Claude compaction boundaries through the same event service", () => {
    const session = Object.assign(emptySession("session", "D:\\work", "", "", "claude"), { threadId: "thread" });
    const harness = createHarness({ session });

    harness.controller.handleEnvelope(event("claude/sdkMessage", {
      type: "system",
      subtype: "compact_boundary",
      uuid: "compact-1",
      nativeSessionId: "thread",
    }, { provider: "claude", sessionId: "session", queryGeneration: 1 }));

    assert.deepEqual(harness.rememberedCompactions, ["thread"]);
    assert.equal(harness.sessions.session.compactionCount, 1);
  });

  it("ignores late side effects from an older Query generation", () => {
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

  it("reloads skills only for the Provider that reported a change", () => {
    const harness = createHarness();

    harness.controller.handleEnvelope(event("skills/changed"));

    assert.deepEqual(harness.skillReloadProviders, ["codex"]);
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
    assert.deepEqual(harness.recoveredSessionIds, [undefined]);
  });

  it("routes an isolated Codex service exit only to its owning page", () => {
    const first = Object.assign(emptySession("first", "D:\\work"), { threadId: "thread-first", capabilities: { ...CODEX_CAPABILITIES } });
    const second = Object.assign(emptySession("second", "D:\\work"), { threadId: "thread-second", capabilities: { ...CODEX_CAPABILITIES } });
    const harness = createHarness({ first, second });
    harness.controller.bindSession("codex", "thread-first", "first");
    harness.controller.bindSession("codex", "thread-second", "second");

    harness.controller.handleEnvelope(event("client/server-exited", {}, { sessionId: "first" }));

    assert.deepEqual(harness.recovered, ["codex"]);
    assert.deepEqual(harness.recoveredSessionIds, ["first"]);
    assert.equal(harness.controller.sessionFor("codex", "thread-first"), "first");
    assert.equal(harness.controller.sessionFor("codex", "thread-second"), "second");
  });

  it("refreshes a fallback title only after a completed turn event", () => {
    const harness = createHarness();
    harness.controller.handleEnvelope(event("turn/completed", { threadId: "thread", turn: { id: "turn-1", status: "completed" } }));
    assert.deepEqual(harness.titleRefreshes, [{ sessionId: "session", status: "completed" }]);
  });

  it("does not disconnect the Provider for a non-fatal Codex client error", () => {
    const harness = createHarness();

    harness.controller.handleEnvelope(event("client/error", { threadId: "thread", message: "request failed" }));

    assert.deepEqual(harness.recovered, []);
    assert.equal(harness.sessions.session.status, "idle");
    assert.deepEqual(harness.raw, [{ sessionId: "session", type: "client/error" }]);
  });

  it("passes a requested Provider when opening a workspace", () => {
    const harness = createHarness();

    harness.controller.handleEnvelope(event("client/open-workspace", { workspace: "D:\\target", provider: "claude" }));

    assert.deepEqual(harness.openedWorkspaces, [{ workspace: "D:\\target", provider: "claude" }]);
  });

  it("activates an open session from a desktop notification", () => {
    const harness = createHarness();

    harness.controller.handleEnvelope(event("client/activate-session", { sessionId: "session" }));
    harness.controller.handleEnvelope(event("client/activate-session", { sessionId: "closed" }));

    assert.deepEqual(harness.activatedSessions, ["session"]);
  });
});
