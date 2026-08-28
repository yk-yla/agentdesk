import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asRecord, emptySession } from "./domain";
import { authorizeRestoredSessionWorkspaces, createWorkspaceState, parseWorkspaceState, workspaceStateFingerprint } from "./workspaceState";

describe("update workspace state budgets", () => {
  it("keeps authorized restored sessions and marks only denied workspaces", async () => {
    const allowed = emptySession("allowed", "C:\\allowed");
    const denied = emptySession("denied", "C:\\denied");
    const result = await authorizeRestoredSessionWorkspaces({ allowed, denied }, async (cwd) => cwd.includes("allowed") ? cwd : null);
    assert.equal(result.sessions.allowed.status, "idle");
    assert.equal(result.sessions.denied.status, "error");
    assert.match(result.sessions.denied.errorText, /未获授权/);
    assert.deepEqual([...result.blockedSessionIds], ["denied"]);
  });

  it("removes the history loading state when a restored workspace is denied", async () => {
    const session = emptySession("denied-history", "C:\\denied", "gpt", "medium", "codex");
    session.threadId = "codex-thread";
    session.historyLoading = true;
    const result = await authorizeRestoredSessionWorkspaces({ [session.id]: session }, async () => null);
    assert.equal(result.sessions[session.id].historyLoading, false);
    assert.equal(result.sessions[session.id].status, "error");
  });

  it("restores each tab with its original Provider", () => {
    const codex = emptySession("codex-session", "C:\\work", "gpt", "medium", "codex");
    const claude = emptySession("claude-session", "C:\\work", "sonnet", "high", "claude");
    codex.threadId = "codex-thread";
    claude.threadId = "claude-thread";
    const state = createWorkspaceState({
      workspace: "C:\\work",
      layout: { panes: [{ id: "pane-1", tabIds: [codex.id, claude.id], activeTabId: claude.id }], activePaneId: "pane-1" },
      sessions: { [codex.id]: codex, [claude.id]: claude },
      drafts: new Map(),
      attachments: {},
      queuedMessages: {},
      pendingSteers: {},
      sidebarCollapsed: false,
    });

    const restored = parseWorkspaceState(state, "C:\\work");
    assert.equal(restored?.sessions[codex.id]?.provider, "codex");
    assert.equal(restored?.sessions[claude.id]?.provider, "claude");
    assert.equal(restored?.sessions[codex.id]?.historyLoading, true);
    assert.equal(restored?.sessions[claude.id]?.historyLoading, true);
  });

  it("restores native sessions as workbench sessions", () => {
    const restored = emptySession("restored-session", "C:\\work", "gpt", "medium", "codex");
    restored.threadId = "codex-thread";
    const state = createWorkspaceState({
      workspace: restored.cwd,
      layout: { panes: [{ id: "pane-1", tabIds: [restored.id], activeTabId: restored.id }], activePaneId: "pane-1" },
      sessions: { [restored.id]: restored },
      drafts: new Map(),
      attachments: {},
      queuedMessages: {},
      pendingSteers: {},
      sidebarCollapsed: false,
    });

    const parsed = parseWorkspaceState(state, restored.cwd);
    assert.equal(parsed?.sessions[restored.id].threadId, "codex-thread");
    assert.equal(parsed?.sessions[restored.id].status, "idle");
    assert.equal(parsed?.sessions[restored.id].historyLoading, true);
    assert.deepEqual(parsed?.threadSessionIds, [restored.id]);
  });

  it("restores a multi-workspace snapshot even when the launch workspace differs", () => {
    const left = emptySession("left", "C:\\left");
    const right = emptySession("right", "D:\\right", "sonnet", "medium", "claude");
    const state = createWorkspaceState({
      workspace: right.cwd,
      layout: {
        panes: [
          { id: "pane-left", tabIds: [left.id], activeTabId: left.id },
          { id: "pane-right", tabIds: [right.id], activeTabId: right.id },
        ],
        activePaneId: "pane-right",
      },
      sessions: { [left.id]: left, [right.id]: right },
      drafts: new Map(),
      attachments: {},
      queuedMessages: {},
      pendingSteers: {},
      sidebarCollapsed: false,
    });

    const restored = parseWorkspaceState(state, "E:\\launch");
    assert.equal(restored?.layout.panes.length, 2);
    assert.equal(restored?.layout.activePaneId, "pane-right");
    assert.equal(restored?.sessions.right.cwd, "D:\\right");
  });

  it("caps oversized drafts and records truncation", () => {
    const session = emptySession("session-1", "C:\\work", "model", "medium");
    const state = createWorkspaceState({
      workspace: "C:\\work",
      layout: { panes: [{ id: "pane-1", tabIds: [session.id], activeTabId: session.id }], activePaneId: "pane-1" },
      sessions: { [session.id]: session },
      drafts: new Map([[session.id, "x".repeat(2_000_000)]]),
      attachments: {},
      queuedMessages: {},
      pendingSteers: {},
      sidebarCollapsed: false,
    });

    assert.equal(asRecord(state).truncated, true);
    assert.ok(new TextEncoder().encode(JSON.stringify(state)).byteLength < 4 * 1024 * 1024);
    const restored = parseWorkspaceState(state, "C:\\work");
    assert.equal(restored?.truncated, true);
    assert.ok((restored?.drafts.get(session.id)?.length || 0) <= 200_000);
  });

  it("keeps the active tab when more than sixty tabs are open", () => {
    const sessions = Object.fromEntries(Array.from({ length: 61 }, (_, index) => {
      const session = emptySession(`session-${index}`, "C:\\work");
      return [session.id, session];
    }));
    const sessionIds = Object.keys(sessions);
    const state = createWorkspaceState({
      workspace: "C:\\work",
      layout: { panes: [{ id: "pane-1", tabIds: sessionIds, activeTabId: sessionIds[60] }], activePaneId: "pane-1" },
      sessions,
      drafts: new Map(),
      attachments: {},
      queuedMessages: {},
      pendingSteers: {},
      sidebarCollapsed: false,
    });

    const restored = parseWorkspaceState(state, "C:\\work");
    assert.equal(restored?.truncated, true);
    assert.equal(restored?.layout.panes[0].activeTabId, sessionIds[60]);
    assert.ok(restored?.sessions[sessionIds[60]]);
  });

  it("marks a single ASCII draft truncated before the parser limit", () => {
    const session = emptySession("session-1", "C:\\work");
    const state = createWorkspaceState({
      workspace: session.cwd,
      layout: { panes: [{ id: "pane-1", tabIds: [session.id], activeTabId: session.id }], activePaneId: "pane-1" },
      sessions: { [session.id]: session },
      drafts: new Map([[session.id, "x".repeat(300_000)]]),
      attachments: {},
      queuedMessages: {},
      pendingSteers: {},
      sidebarCollapsed: false,
    });

    const restored = parseWorkspaceState(state, session.cwd);
    assert.equal(restored?.truncated, true);
    assert.equal(restored?.drafts.get(session.id)?.length, 200_000);
  });

  it("fits heavily escaped drafts within the workspace-state byte budget", () => {
    const sessions = Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
      const session = emptySession(`session-${index}`, "C:\\work");
      return [session.id, session];
    }));
    const sessionIds = Object.keys(sessions);
    const state = createWorkspaceState({
      workspace: "C:\\work",
      layout: { panes: [{ id: "pane-1", tabIds: sessionIds, activeTabId: sessionIds[11] }], activePaneId: "pane-1" },
      sessions,
      drafts: new Map(sessionIds.map((sessionId) => [sessionId, "\\".repeat(200_000)])),
      attachments: {},
      queuedMessages: {},
      pendingSteers: {},
      sidebarCollapsed: false,
    });

    assert.equal(asRecord(state).truncated, true);
    assert.ok(new TextEncoder().encode(JSON.stringify(state)).byteLength <= 2_500_000);
    assert.ok((asRecord(state).truncationReasons as unknown[]).includes("serializedSize"));
  });

  it("includes skill metadata in the total recovery budget", () => {
    const session = emptySession("session-1", "C:\\work", "model", "medium");
    const queuedMessages = Array.from({ length: 500 }, (_, index) => ({
      id: `queued-${index}`,
      text: "queued",
      images: [],
      skills: Array.from({ length: 16 }, (_, skillIndex) => ({
        name: `skill-${skillIndex}`,
        path: `C:\\skills\\${"x".repeat(5_000)}`,
        description: "",
        scope: "user",
        enabled: true,
      })),
    }));
    const state = createWorkspaceState({
      workspace: "C:\\work",
      layout: { panes: [{ id: "pane-1", tabIds: [session.id], activeTabId: session.id }], activePaneId: "pane-1" },
      sessions: { [session.id]: session },
      drafts: new Map(),
      attachments: {},
      queuedMessages: { [session.id]: queuedMessages },
      pendingSteers: {},
      sidebarCollapsed: false,
    });

    assert.equal(asRecord(state).truncated, true);
    assert.ok(new TextEncoder().encode(JSON.stringify(state)).byteLength < 4 * 1024 * 1024);
    const restored = parseWorkspaceState(state, "C:\\work");
    assert.ok((restored?.queuedMessages[session.id]?.length || 0) > 0);
  });

  it("budgets Chinese recovery text by UTF-8 bytes", () => {
    const sessions = Object.fromEntries(Array.from({ length: 20 }, (_, index) => {
      const session = emptySession(`session-${index}`, "C:\\work", "model", "medium");
      return [session.id, session];
    }));
    const sessionIds = Object.keys(sessions);
    const queuedMessages = [{ id: "queued-1", text: "需要恢复的排队消息", images: [] }];
    const state = createWorkspaceState({
      workspace: "C:\\work",
      layout: { panes: [{ id: "pane-1", tabIds: sessionIds, activeTabId: sessionIds[0] }], activePaneId: "pane-1" },
      sessions,
      drafts: new Map(sessionIds.map((sessionId) => [sessionId, "文".repeat(200_000)])),
      attachments: {},
      queuedMessages: { [sessionIds[0]]: queuedMessages },
      pendingSteers: {},
      sidebarCollapsed: false,
    });

    assert.equal(asRecord(state).truncated, true);
    assert.ok(new TextEncoder().encode(JSON.stringify(state)).byteLength < 4 * 1024 * 1024);
    assert.ok((parseWorkspaceState(state, "C:\\work")?.queuedMessages[sessionIds[0]]?.length || 0) > 0);
  });

  it("restores two panes, active tabs, drafts, attachments and queues after a later restart", () => {
    const first = emptySession("session-first", "C:\\work", "gpt", "high", "codex");
    const second = emptySession("session-second", "C:\\other", "sonnet", "medium", "claude");
    first.threadId = "codex-thread";
    second.threadId = "claude-thread";
    second.status = "working";
    second.statusLabel = "工作中";
    const state = createWorkspaceState({
      workspace: "C:\\work",
      layout: {
        panes: [
          { id: "pane-left", tabIds: [first.id], activeTabId: first.id },
          { id: "pane-right", tabIds: [second.id], activeTabId: second.id },
        ],
        activePaneId: "pane-right",
      },
      sessions: { [first.id]: first, [second.id]: second },
      drafts: new Map([[second.id, "重启后仍在的草稿"]]),
      attachments: { [second.id]: [{ path: "C:\\images\\draft.png", name: "draft.png", dataUrl: "data:image/png;base64,AA==" }] },
      queuedMessages: { [second.id]: [{ id: "queued-1", text: "下一轮消息", images: [] }] },
      pendingSteers: { [second.id]: [{ id: "steer-1", text: "等待中的补充", images: [], sequence: 2, clientUserMessageId: "client-1", expectedTurnId: "turn-1" }] },
      sidebarCollapsed: true,
    });
    const savedAt = Number(asRecord(state).savedAt);
    const originalNow = Date.now;
    Date.now = () => savedAt + 365 * 24 * 60 * 60 * 1000;
    try {
      const restored = parseWorkspaceState(state, "C:\\work");
      assert.equal(restored?.layout.panes.length, 2);
      assert.equal(restored?.layout.activePaneId, "pane-right");
      assert.equal(restored?.layout.panes[1].activeTabId, second.id);
      assert.equal(restored?.sessions[second.id].provider, "claude");
      assert.equal(restored?.sessions[second.id].status, "idle");
      assert.equal(restored?.sessions[second.id].statusLabel, "任务已停止");
      assert.deepEqual(restored?.stoppedSessionIds, [second.id]);
      assert.equal(restored?.drafts.get(second.id), "重启后仍在的草稿");
      assert.equal(restored?.attachments[second.id][0].path, "C:\\images\\draft.png");
      assert.deepEqual(restored?.queuedMessages[second.id].map((message) => message.queueKind), [undefined, "rejectedSteer"]);
      assert.equal(restored?.sidebarCollapsed, true);
    } finally {
      Date.now = originalNow;
    }
  });

  it("uses a stable fingerprint while savedAt changes", () => {
    const session = emptySession("session-1", "C:\\work");
    const input = {
      workspace: "C:\\work",
      layout: { panes: [{ id: "pane-1", tabIds: [session.id], activeTabId: session.id }], activePaneId: "pane-1" },
      sessions: { [session.id]: session },
      drafts: new Map<string, string>(),
      attachments: {},
      queuedMessages: {},
      pendingSteers: {},
      sidebarCollapsed: false,
    };
    const first = createWorkspaceState(input);
    const originalNow = Date.now;
    Date.now = () => originalNow() + 10_000;
    try {
      assert.equal(workspaceStateFingerprint(first), workspaceStateFingerprint(createWorkspaceState(input)));
    } finally {
      Date.now = originalNow;
    }
  });
});
