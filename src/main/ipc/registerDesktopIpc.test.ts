import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizePreferencesPatch, validateAgentRequest, validateAgentResponse } from "./registerDesktopIpc";

describe("desktop IPC validation", () => {
  it("sanitizes preference patches without trusting renderer types", () => {
    const updatedAt = Date.now();
    assert.deepEqual(sanitizePreferencesPatch(null), {});
    assert.deepEqual(sanitizePreferencesPatch({
      theme: "dracula",
      sidebarWidth: 999,
      baseFontSize: 99,
      recentWorkspaces: ["one", 2],
      claudeModelCache: { schema: 1, claudeVersion: "1.2.3", updatedAt, models: [{ id: "sonnet", displayName: "Sonnet", efforts: [], defaultEffort: "", supportsImage: true }] },
      workspaceState: [],
      ignored: true,
    }), {
      theme: "dracula",
      sidebarWidth: 480,
      baseFontSize: 14,
      recentWorkspaces: ["one"],
      claudeModelCache: { schema: 1, claudeVersion: "1.2.3", updatedAt, models: [{ id: "sonnet", displayName: "Sonnet", description: "", efforts: [], defaultEffort: "", supportsImage: true }] },
    });
  });

  it("accepts only known Provider operations and bounded ownership context", () => {
    const request = validateAgentRequest({
      provider: "claude",
      operation: "startTurn",
      params: { prompt: "hello" },
      context: { sessionId: "session", queryGeneration: 2, nativeSessionId: "x".repeat(300) },
    });
    assert.deepEqual(request.context, { sessionId: "session", queryGeneration: 2 });
    assert.throws(() => validateAgentRequest({ provider: "claude", operation: "unknown", params: {} }), /未获授权/);
    assert.throws(() => validateAgentRequest({ provider: "codex", operation: "startTurn", params: [] }), /参数无效/);
  });

  it("rejects interaction responses without a valid Provider and object result", () => {
    assert.throws(() => validateAgentResponse({ ref: { provider: "other" }, result: {} }), /响应无效/);
    assert.throws(() => validateAgentResponse({ ref: { provider: "codex" }, result: [] }), /响应无效/);
  });
});
