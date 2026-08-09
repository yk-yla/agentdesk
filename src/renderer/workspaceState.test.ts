import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asRecord, emptySession } from "./domain";
import { createUpdateWorkspaceState, parseUpdateWorkspaceState } from "./workspaceState";

describe("update workspace state budgets", () => {
  it("caps oversized drafts and records truncation", () => {
    const session = emptySession("session-1", "C:\\work", "model", "medium");
    const state = createUpdateWorkspaceState({
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
    const restored = parseUpdateWorkspaceState(state, "C:\\work");
    assert.equal(restored?.truncated, true);
    assert.ok((restored?.drafts.get(session.id)?.length || 0) <= 200_000);
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
    const state = createUpdateWorkspaceState({
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
    const restored = parseUpdateWorkspaceState(state, "C:\\work");
    assert.ok((restored?.queuedMessages[session.id]?.length || 0) > 0);
  });

  it("budgets Chinese recovery text by UTF-8 bytes", () => {
    const sessions = Object.fromEntries(Array.from({ length: 20 }, (_, index) => {
      const session = emptySession(`session-${index}`, "C:\\work", "model", "medium");
      return [session.id, session];
    }));
    const sessionIds = Object.keys(sessions);
    const queuedMessages = [{ id: "queued-1", text: "需要恢复的排队消息", images: [] }];
    const state = createUpdateWorkspaceState({
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
    assert.ok((parseUpdateWorkspaceState(state, "C:\\work")?.queuedMessages[sessionIds[0]]?.length || 0) > 0);
  });
});
