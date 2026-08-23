import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizePreferencesPatch, validateAgentRequest, validateAgentResponse, validateClientLog, validateTerminalCommand, validateTerminalInput, validateTerminalResize, validateTerminalStart, validateWorkspaceSnapshotSubmission } from "./registerDesktopIpc";

describe("desktop IPC validation", () => {
  it("validates bounded terminal operations", () => {
    assert.deepEqual(validateTerminalStart({ provider: "claude", sessionId: "session-1", cwd: "C:\\work", cols: 80, rows: 24 }), {
      provider: "claude", sessionId: "session-1", cwd: "C:\\work", cols: 80, rows: 24,
    });
    assert.deepEqual(validateTerminalInput({ sessionId: "session-1", generation: 2, data: "abc" }), { sessionId: "session-1", generation: 2, data: "abc" });
    assert.deepEqual(validateTerminalResize({ sessionId: "session-1", generation: 2, cols: 100, rows: 30 }), { sessionId: "session-1", generation: 2, cols: 100, rows: 30 });
    assert.deepEqual(validateTerminalCommand({ sessionId: "session-1" }), { sessionId: "session-1" });
    assert.throws(() => validateTerminalStart({ provider: "codex", sessionId: "bad id", cwd: "C:\\work" }), /会话 ID/);
    assert.throws(() => validateTerminalStart({ provider: "codex", sessionId: "session-1", cwd: "C:\\work", resume: true }), /原生会话 ID/);
    assert.throws(() => validateTerminalInput({ sessionId: "session-1", generation: 0, data: "abc" }), /代次/);
    assert.throws(() => validateTerminalInput({ sessionId: "session-1", generation: 1, data: "x".repeat(70 * 1024) }), /过大/);
  });
  it("sanitizes preference patches without trusting renderer types", () => {
    const updatedAt = Date.now();
    assert.deepEqual(sanitizePreferencesPatch(null), {});
    assert.deepEqual(sanitizePreferencesPatch({
      theme: "modern-dark",
      sidebarWidth: 999,
      baseFontSize: 99,
      claudeModelCache: { schema: 2, claudeVersion: "1.2.3", updatedAt, models: [{ id: "sonnet", displayName: "Sonnet", efforts: [], defaultEffort: "", supportsImage: true }] },
      lastReasoningEfforts: { codex: " xhigh ", claude: "high", unknown: "medium" },
      recentCommandUsage: { "skill:latest": 30, "command:older": 20, invalid: 99 },
      codexCompactionCounts: { "codex:thread-1": { count: 12, eventIds: ["compact-1", 2], updatedAt: 100 } },
      compactionCounts: { "claude:thread-2": { count: 8, eventIds: ["claude-compact-1", 2], updatedAt: 200 } },
      workspaceState: [],
      ignored: true,
    }), {
      theme: "modern-dark",
      sidebarWidth: 480,
      baseFontSize: 14,
      claudeModelCache: { schema: 2, claudeVersion: "1.2.3", updatedAt, models: [{ id: "sonnet", displayName: "Sonnet", description: "", efforts: [], defaultEffort: "", supportsImage: true }] },
      lastReasoningEfforts: { codex: "xhigh", claude: "high" },
      recentCommandUsage: { "skill:latest": 30, "command:older": 20 },
      codexCompactionCounts: { "codex:thread-1": { count: 12, eventIds: ["compact-1"], updatedAt: 100 } },
      compactionCounts: { "claude:thread-2": { count: 8, eventIds: ["claude-compact-1"], updatedAt: 200 } },
    });
    assert.deepEqual(sanitizePreferencesPatch({ theme: "dracula" }), {});
  });

  it("accepts only known Provider operations and bounded ownership context", () => {
    const request = validateAgentRequest({
      provider: "claude",
      operation: "startTurn",
      params: { prompt: "hello" },
      context: { requestId: "req-123", sessionId: "session", queryGeneration: 2, nativeSessionId: "x".repeat(300) },
    });
    assert.deepEqual(request.context, { requestId: "req-123", sessionId: "session", queryGeneration: 2 });
    const titleRequest = validateAgentRequest({
      provider: "codex",
      operation: "generateSessionTitle",
      params: { threadId: "thread", conversation: "hello" },
      context: { sessionId: "session", canonicalCwd: "D:\\work", nativeSessionId: "thread" },
    });
    assert.equal(titleRequest.operation, "generateSessionTitle");
    assert.throws(() => validateAgentRequest({ provider: "claude", operation: "unknown", params: {} }), /未获授权/);
    assert.throws(() => validateAgentRequest({ provider: "codex", operation: "startTurn", params: [] }), /参数无效/);
  });

  it("rejects interaction responses without a valid Provider and object result", () => {
    assert.throws(() => validateAgentResponse({ ref: { provider: "other" }, result: {} }), /响应无效/);
    assert.throws(() => validateAgentResponse({ ref: { provider: "codex" }, result: [] }), /响应无效/);
  });

  it("accepts bounded client diagnostics and rejects malformed entries", () => {
    assert.deepEqual(validateClientLog({ level: "error", event: "ui.click", details: { tag: "button" } }), { level: "error", event: "ui.click", details: { tag: "button" } });
    assert.throws(() => validateClientLog({ level: "trace", event: "bad" }), /客户端日志无效/);
    assert.throws(() => validateClientLog({ event: "" }), /客户端日志无效/);
    assert.throws(() => validateClientLog({ event: "too-large", details: { payload: "x".repeat(64 * 1024) } }), /客户端日志无效/);
  });

  it("accepts only bounded workspace snapshot responses", () => {
    assert.deepEqual(validateWorkspaceSnapshotSubmission({ requestId: "snapshot-123", workspaceState: { version: 1 } }), {
      requestId: "snapshot-123",
      workspaceState: { version: 1 },
    });
    assert.throws(() => validateWorkspaceSnapshotSubmission({ requestId: "../bad", workspaceState: {} }), /快照响应无效/);
    assert.throws(() => validateWorkspaceSnapshotSubmission({ requestId: "snapshot", workspaceState: [] }), /快照响应无效/);
  });
});
