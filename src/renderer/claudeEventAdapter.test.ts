import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptySession, findModelOption } from "./domain";
import { adaptClaudeEvent, applyClaudeEvent, hydrateClaudeSession, normalizeClaudeModel } from "./providers/claude/claudeEventAdapter";

function event(type: string, payload: unknown, queryGeneration = 1) {
  return adaptClaudeEvent({ provider: "claude", sessionId: "session", queryGeneration, receivedAt: Date.now(), type, payload });
}

describe("Claude activity settlement", () => {
  it("hydrates string and block content from Claude session history", () => {
    const source = emptySession("session", "C:\\workspace", "", "", "claude");
    const hydrated = hydrateClaudeSession(source, {
      id: "native-session",
      messages: [
        {
          type: "user",
          uuid: "command",
          message: {
            role: "user",
            content: "<command-name>/model</command-name>\n<command-message>model</command-message>",
          },
        },
        {
          type: "user",
          uuid: "prompt",
          message: { role: "user", content: "保留普通字符串消息" },
        },
        {
          type: "assistant",
          uuid: "answer",
          message: { role: "assistant", content: [{ type: "text", text: "历史回复" }] },
        },
        {
          type: "assistant",
          uuid: "answer",
          message: { role: "assistant", content: [{ type: "text", text: "历史回复（最终）" }] },
        },
        {
          type: "assistant",
          uuid: "answer-duplicate",
          message: { role: "assistant", content: [{ type: "text", text: "历史回复（最终）" }] },
        },
      ],
    });

    assert.equal(hydrated.threadId, "native-session");
    assert.deepEqual(hydrated.messages.map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "/model" },
      { role: "user", text: "保留普通字符串消息" },
      { role: "assistant", text: "历史回复（最终）" },
    ]);
  });

  it("matches a resolved SDK model ID to its selectable alias", () => {
    const model = normalizeClaudeModel({
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      supportedEffortLevels: ["medium", "high"],
    });
    assert.equal(model.resolvedId, "claude-sonnet-5");
    assert.equal(findModelOption([model], "claude-sonnet-5")?.id, "sonnet");
  });

  it("keeps the selected alias when Claude reports a shared resolved model", () => {
    const models = [
      { id: "default", resolvedId: "claude-opus-5[1m]", displayName: "Default", description: "", efforts: [], defaultEffort: "", supportsImage: true },
      { id: "opus[1m]", resolvedId: "claude-opus-5[1m]", displayName: "Opus (1M)", description: "", efforts: [], defaultEffort: "", supportsImage: true },
    ];
    assert.equal(findModelOption(models, "opus[1m]")?.id, "opus[1m]");

    const source = emptySession("session", "C:\\workspace", "opus[1m]", "medium", "claude");
    const initialized = applyClaudeEvent(source, event("claude/sdkMessage", {
      type: "system",
      subtype: "init",
      model: "claude-opus-5[1m]",
    })).session;

    assert.equal(event("claude/sdkMessage", { type: "system", subtype: "init", model: "claude-opus-5[1m]" }).kind, "state");
    assert.equal(initialized.model, "opus[1m]");
    assert.equal(initialized.resolvedModel, "claude-opus-5[1m]");
  });

  it("keeps known context usage when a result omits usage details", () => {
    const source = emptySession("session", "C:\\workspace", "opus[1m]", "medium", "claude");
    source.tokenUsage = { used: 120, total: 1_000_000 };
    const malformed = applyClaudeEvent(source, event("claude/contextUsage", { nativeSessionId: "native" })).session;
    assert.deepEqual(malformed.tokenUsage, source.tokenUsage);

    const withContext = applyClaudeEvent(source, event("claude/contextUsage", {
      nativeSessionId: "native",
      used: 23_300,
      total: 1_000_000,
    })).session;
    const completed = applyClaudeEvent(withContext, event("claude/sdkMessage", { type: "result", is_error: false })).session;

    assert.deepEqual(completed.tokenUsage, { used: 23_300, total: 1_000_000 });
  });

  it("settles unfinished tools on result, interruption and backend exit", () => {
    const source = emptySession("session", "C:\\workspace", "", "", "claude");
    source.activities = [{ id: "tool", kind: "commandExecution", title: "Bash", detail: "running", status: "inProgress", visibleInMain: false }];
    const completed = applyClaudeEvent(source, event("claude/sdkMessage", { type: "result", is_error: false })).session;
    assert.equal(completed.activities[0].status, "completed");
    const interrupted = applyClaudeEvent(source, event("claude/turnCompleted", { status: "interrupted" })).session;
    assert.equal(interrupted.activities[0].status, "failed");
    const exited = applyClaudeEvent(source, event("claude/backendExited", { message: "worker stopped" })).session;
    assert.equal(exited.activities[0].status, "failed");
  });

  it("routes gateway errors as failed turn completion so queues can recover", () => {
    const routed = event("claude/error", { nativeSessionId: "native", message: "Claude 网关认证失败（401）。" });
    assert.equal(routed.kind, "turnCompleted");
    assert.equal(routed.turnStatus, "failed");
    const source = emptySession("session", "C:\\workspace", "", "", "claude");
    source.status = "working";
    source.activeTurnId = "turn";
    const failed = applyClaudeEvent(source, routed).session;
    assert.equal(failed.status, "error");
    assert.equal(failed.activeTurnId, null);
  });

  it("ignores capabilities and lifecycle events from an older Query generation", () => {
    const source = emptySession("session", "C:\\workspace", "", "", "claude");
    source.queryGeneration = 2;
    source.status = "working";
    source.capabilities.compact = "temporarilyUnavailable";
    const capability = applyClaudeEvent(source, event("claude/capabilitiesUpdated", { capabilities: { compact: "supported" } }, 1));
    assert.equal(capability.ignored, true);
    assert.equal(capability.session.capabilities.compact, "temporarilyUnavailable");
    const closed = applyClaudeEvent(source, event("claude/queryClosed", {}, 1));
    assert.equal(closed.ignored, true);
    assert.equal(closed.session.status, "working");
  });
});
