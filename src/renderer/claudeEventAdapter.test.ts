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
          timestamp: "2026-08-12T01:02:03.000Z",
          message: { role: "user", content: "保留普通字符串消息" },
        },
        {
          type: "assistant",
          uuid: "answer",
          message: { id: "message-answer", role: "assistant", content: [{ type: "text", text: "历史回复" }] },
        },
        {
          type: "assistant",
          uuid: "answer-block",
          message: { id: "message-answer", role: "assistant", content: [{ type: "text", text: "历史回复（最终）" }] },
        },
        {
          type: "assistant",
          uuid: "answer-duplicate",
          message: { id: "message-second", role: "assistant", content: [{ type: "text", text: "另一条回复" }] },
        },
      ],
    });

    assert.equal(hydrated.threadId, "native-session");
    assert.deepEqual(hydrated.messages.map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "/model" },
      { role: "user", text: "保留普通字符串消息" },
      { role: "assistant", text: "历史回复（最终）" },
      { role: "assistant", text: "另一条回复" },
    ]);
    assert.equal(hydrated.messages[1].timestamp, Date.parse("2026-08-12T01:02:03.000Z"));
  });

  it("keeps distinct Claude messages during streaming and history hydration", () => {
    const source = emptySession("session", "C:\\workspace", "", "", "claude");
    source.status = "working";
    source.activeTurnId = "turn";
    const firstStart = applyClaudeEvent(source, event("claude/sdkMessage", {
      type: "stream_event",
      uuid: "first-start",
      event: { type: "message_start", message: { id: "message-first", role: "assistant", content: [] } },
    })).session;
    const firstDelta = applyClaudeEvent(firstStart, event("claude/sdkMessage", {
      type: "stream_event",
      uuid: "first-delta-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "第一" } },
    })).session;
    const secondDelta = applyClaudeEvent(firstDelta, event("claude/sdkMessage", {
      type: "stream_event",
      uuid: "first-delta-2",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "条" } },
    })).session;
    assert.deepEqual(secondDelta.messages.map(({ text, streaming }) => ({ text, streaming })), [
      { text: "第一条", streaming: true },
    ]);

    const firstFinal = applyClaudeEvent(secondDelta, event("claude/sdkMessage", {
      type: "assistant",
      uuid: "first-final",
      message: { id: "message-first", role: "assistant", content: [{ type: "text", text: "第一条" }] },
    })).session;
    const secondStart = applyClaudeEvent(firstFinal, event("claude/sdkMessage", {
      type: "stream_event",
      uuid: "second-start",
      event: { type: "message_start", message: { id: "message-second", role: "assistant", content: [] } },
    })).session;
    const secondStream = applyClaudeEvent(secondStart, event("claude/sdkMessage", {
      type: "stream_event",
      uuid: "second-delta",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "第二" } },
    })).session;
    const second = applyClaudeEvent(secondStream, event("claude/sdkMessage", {
      type: "assistant",
      uuid: "second-final",
      message: { id: "message-second", role: "assistant", content: [{ type: "text", text: "第二条" }] },
    })).session;

    assert.deepEqual(second.messages.map(({ id, text, streaming }) => ({ id, text, streaming })), [
      { id: "claude-message-message-first", text: "第一条", streaming: false },
      { id: "claude-message-message-second", text: "第二条", streaming: false },
    ]);

    const hydrated = hydrateClaudeSession(second, {
      id: "native-session",
      messages: [
        { type: "assistant", uuid: "first-history", message: { id: "message-first", role: "assistant", content: [{ type: "text", text: "历史旧值" }] } },
      ],
    }, { preserveRealtime: true, preserveLifecycle: true });
    assert.deepEqual(hydrated.messages.map(({ id, text }) => ({ id, text })), [
      { id: "claude-message-message-first", text: "第一条" },
      { id: "claude-message-message-second", text: "第二条" },
    ]);
    assert.equal(hydrated.status, "working");
    assert.equal(hydrated.activeTurnId, "turn");
  });

  it("shows streamed tools immediately and marks incomplete file writes as failed", () => {
    const source = emptySession("session", "C:\\workspace", "", "", "claude");
    source.status = "working";
    source.activeTurnId = "turn";
    const started = applyClaudeEvent(source, event("claude/sdkMessage", {
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", id: "tool-write", name: "Write", input: {} },
      },
    })).session;
    assert.deepEqual(started.activities.map(({ id, kind, status }) => ({ id, kind, status })), [
      { id: "tool-write", kind: "fileChange", status: "inProgress" },
    ]);

    const failed = applyClaudeEvent(started, event("claude/sdkMessage", {
      type: "result",
      subtype: "error_incomplete_tool_use",
      is_error: true,
      errors: ["Claude 的 Write 工具调用未完整执行，文件未写入。请继续当前会话重试。"],
    })).session;
    assert.equal(failed.status, "error");
    assert.match(failed.errorText, /文件未写入/);
    assert.equal(failed.activities[0]?.status, "failed");
  });

  it("removes the empty streaming placeholder for a tool-only assistant message", () => {
    const source = emptySession("session", "C:\\workspace", "", "", "claude");
    const started = applyClaudeEvent(source, event("claude/sdkMessage", {
      type: "stream_event",
      uuid: "tool-start",
      event: { type: "message_start", message: { id: "message-tool", role: "assistant", content: [] } },
    })).session;
    assert.equal(started.messages.length, 1);

    const finalized = applyClaudeEvent(started, event("claude/sdkMessage", {
      type: "assistant",
      uuid: "tool-final",
      message: { id: "message-tool", role: "assistant", content: [{ type: "tool_use", id: "tool-read", name: "Read", input: {} }] },
    })).session;
    assert.equal(finalized.messages.length, 0);
    assert.equal(finalized.activities[0]?.id, "tool-read");
  });

  it("keeps completed text when the same Claude message later reports a tool block", () => {
    const source = emptySession("session", "C:\\workspace", "", "", "claude");
    source.messages = [{ id: "claude-message-message-mixed", role: "assistant", text: "先说明，再调用工具。", images: [], streaming: false }];
    const finalized = applyClaudeEvent(source, event("claude/sdkMessage", {
      type: "assistant",
      uuid: "mixed-tool-block",
      message: { id: "message-mixed", role: "assistant", content: [{ type: "tool_use", id: "tool-read", name: "Read", input: {} }] },
    })).session;

    assert.deepEqual(finalized.messages.map(({ id, text }) => ({ id, text })), [
      { id: "claude-message-message-mixed", text: "先说明，再调用工具。" },
    ]);
    assert.equal(finalized.activities[0]?.id, "tool-read");
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

  it("restores the last resolved Claude model from session history", () => {
    const source = emptySession("session", "C:\\workspace", "default", "medium", "claude");
    const hydrated = hydrateClaudeSession(source, {
      id: "native-session",
      model: "claude-sonnet-5",
      messages: [],
    });
    assert.equal(hydrated.model, "claude-sonnet-5");
    assert.equal(hydrated.resolvedModel, "claude-sonnet-5");
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

  it("counts Claude compaction boundaries in realtime and restored history", () => {
    const source = emptySession("session", "C:\\workspace", "", "", "claude");
    const compacted = applyClaudeEvent(source, event("claude/sdkMessage", {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 2_000, post_tokens: 800 },
    })).session;
    assert.equal(compacted.compactionCount, 1);

    const hydrated = hydrateClaudeSession(source, {
      id: "native-session",
      messages: [
        { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 2_000 } },
        { type: "assistant", uuid: "answer", message: { role: "assistant", content: [{ type: "text", text: "压缩后回复" }] } },
      ],
    });
    assert.equal(hydrated.compactionCount, 1);
    assert.equal(hydrated.messages[0]?.text, "压缩后回复");
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
