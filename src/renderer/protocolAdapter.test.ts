import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptySession } from "./domain";
import { applyServerMessage, hydrateSession } from "./providers/codex/codexEventAdapter";

describe("protocolAdapter turn lifecycle", () => {
  for (const status of ["completed", "failed", "interrupted"] as const) {
    it(`closes streaming state for ${status} turns`, () => {
      const session = emptySession("session-1", "C:\\work");
      session.status = "working";
      session.activeTurnId = "turn-1";
      session.startedAt = Date.now();
      session.messages = [{ id: "agent-1", role: "assistant", text: "partial", images: [], streaming: true }];

      const applied = applyServerMessage(session, {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status } },
      }).session;

      assert.equal(applied.status, "idle");
      assert.equal(applied.activeTurnId, null);
      assert.equal(applied.startedAt, null);
      assert.equal(applied.messages[0].streaming, false);
    });
  }

  it("closes a non-retryable error without leaving an active turn", () => {
    const session = emptySession("session-1", "C:\\work");
    session.status = "working";
    session.activeTurnId = "turn-1";
    session.startedAt = Date.now();
    session.messages = [{ id: "agent-1", role: "assistant", text: "partial", images: [], streaming: true }];

    const applied = applyServerMessage(session, {
      method: "error",
      params: { threadId: "thread-1", willRetry: false, error: { message: "failed" } },
    }).session;

    assert.equal(applied.status, "error");
    assert.equal(applied.activeTurnId, null);
    assert.equal(applied.startedAt, null);
    assert.equal(applied.messages[0].streaming, false);
  });

  it("settles a reasoning activity when its item completes without an explicit status", () => {
    const session = emptySession("session-1", "C:\\work");
    const started = applyServerMessage(session, {
      method: "item/started",
      params: { threadId: "thread-1", item: { id: "reasoning-1", type: "reasoning", summary: ["先检查项目"] } },
    }).session;
    assert.equal(started.activities[0].status, "inProgress");

    const completed = applyServerMessage(started, {
      method: "item/completed",
      params: { threadId: "thread-1", item: { id: "reasoning-1", type: "reasoning", summary: ["先检查项目"] } },
    }).session;
    assert.equal(completed.activities[0].status, "completed");
  });

  it("settles a reasoning activity when the turn ends without an item completion", () => {
    const session = emptySession("session-1", "C:\\work");
    session.status = "working";
    session.activeTurnId = "turn-1";
    session.activities = [{ id: "reasoning-1", kind: "reasoning", title: "思考摘要", detail: "检查中", status: "inProgress", visibleInMain: false }];

    const applied = applyServerMessage(session, {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    }).session;
    assert.equal(applied.activities[0].status, "completed");
  });
});

describe("protocolAdapter hydration", () => {
  const activeThread = {
    id: "thread-1",
    cwd: "C:\\work",
    turns: [{
      id: "turn-1",
      status: "inProgress",
      startedAt: 100,
      items: [{ id: "agent-1", type: "agentMessage", text: "snapshot" }],
    }],
  };

  it("restores an active historical turn as working", () => {
    const hydrated = hydrateSession(emptySession("session-1", "C:\\work"), activeThread);
    assert.equal(hydrated.status, "working");
    assert.equal(hydrated.activeTurnId, "turn-1");
    assert.equal(hydrated.messages[0].timestamp, 100_000);
  });

  it("uses Codex lifecycle timestamps for realtime messages", () => {
    const source = emptySession("session-1", "C:\\work");
    const user = applyServerMessage(source, {
      method: "item/started",
      params: { threadId: "thread-1", startedAtMs: 123_456, item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "问题" }] } },
    }, 999_999).session;
    const assistant = applyServerMessage(user, {
      method: "item/completed",
      params: { threadId: "thread-1", completedAtMs: 234_567, item: { id: "agent-1", type: "agentMessage", text: "回答" } },
    }, 999_999).session;

    assert.equal(assistant.messages[0].timestamp, 123_456);
    assert.equal(assistant.messages[1].timestamp, 234_567);
  });

  it("preserves realtime content received while thread/read was pending", () => {
    const session = emptySession("session-1", "C:\\work");
    session.messages = [{ id: "agent-1", role: "assistant", text: "snapshot plus realtime", images: [], streaming: true }];
    const hydrated = hydrateSession(session, activeThread, { preserveRealtime: true, preserveLifecycle: false });
    assert.equal(hydrated.messages.length, 1);
    assert.equal(hydrated.messages[0].text, "snapshot plus realtime");
    assert.equal(hydrated.messages[0].streaming, true);
    assert.equal(hydrated.status, "working");
    assert.equal(hydrated.activeTurnId, "turn-1");
  });

  it("keeps a realtime terminal lifecycle newer than an active snapshot", () => {
    const session = emptySession("session-1", "C:\\work");
    session.status = "idle";
    session.statusLabel = "就绪";
    session.activeTurnId = null;
    const hydrated = hydrateSession(session, activeThread, { preserveRealtime: true, preserveLifecycle: true });
    assert.equal(hydrated.status, "idle");
    assert.equal(hydrated.activeTurnId, null);
  });
});

describe("protocolAdapter realtime hydration merge", () => {
  const snapshot = {
    id: "thread-1",
    cwd: "C:\\work",
    turns: [{
      id: "turn-1",
      status: "inProgress",
      startedAt: 100,
      items: [
        { id: "command-1", type: "commandExecution", command: "echo snapshot", status: "completed" },
        { id: "agent-1", type: "agentMessage", text: "snapshot" },
      ],
    }],
  };

  it("preserves realtime activity and approval while restoring snapshot lifecycle", () => {
    let session = emptySession("session-1", "C:\\work");
    session.messages = [{ id: "agent-1", role: "assistant", text: "snapshot plus delta", images: [], streaming: true }];
    session.activities = [{ id: "command-1", kind: "commandExecution", title: "命令执行", detail: "realtime detail", status: "inProgress", visibleInMain: true }];
    const approvalEvent = {
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", command: "echo approval" },
    };
    const approval = applyServerMessage(session, approvalEvent).approval;
    assert.ok(approval);
    session.pendingApprovals = [approval];

    const hydrated = hydrateSession(session, snapshot, { preserveRealtime: true, preserveLifecycle: false });
    assert.equal(hydrated.messages[0].text, "snapshot plus delta");
    assert.equal(hydrated.activities[0].detail, "realtime detail");
    assert.equal(hydrated.pendingApprovals[0].requestId, 42);
    assert.equal(hydrated.status, "working");
    assert.equal(hydrated.activeTurnId, "turn-1");
  });
});

describe("protocolAdapter review messages", () => {
  it("does not create an empty bubble before an agent message has content", () => {
    const session = emptySession("session-1", "C:\\work");
    const started = applyServerMessage(session, {
      method: "item/started",
      params: { threadId: "thread-1", item: { id: "agent-1", type: "agentMessage", text: "" } },
    }).session;

    assert.equal(started.messages.length, 0);

    const streamed = applyServerMessage(started, {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", itemId: "agent-1", delta: "审查中" },
    }).session;

    assert.equal(streamed.messages.length, 1);
    assert.equal(streamed.messages[0].text, "审查中");
    assert.equal(streamed.messages[0].streaming, true);
  });

  it("renders exitedReviewMode.review as the final assistant result", () => {
    const session = emptySession("session-1", "C:\\work");
    session.messages = [{ id: "turn-1", role: "user", text: "Review the current changes", images: [] }];

    const applied = applyServerMessage(session, {
      method: "item/completed",
      params: { threadId: "thread-1", item: { id: "turn-1", type: "exitedReviewMode", review: "未发现问题。" } },
    }).session;

    assert.equal(applied.messages.length, 2);
    assert.equal(applied.messages[0].role, "user");
    assert.equal(applied.messages[1].id, "review-result-turn-1");
    assert.equal(applied.messages[1].role, "assistant");
    assert.equal(applied.messages[1].text, "未发现问题。");
    assert.equal(applied.messages[1].streaming, false);
  });

  it("hydrates the review result without historical empty agent messages", () => {
    const hydrated = hydrateSession(emptySession("session-1", "C:\\work"), {
      id: "thread-1",
      cwd: "C:\\work",
      turns: [{
        id: "turn-1",
        status: "completed",
        items: [
          { id: "agent-empty", type: "agentMessage", text: "" },
          { id: "turn-1", type: "exitedReviewMode", review: "有一个高优先级问题。" },
        ],
      }],
    });

    assert.equal(hydrated.messages.length, 1);
    assert.equal(hydrated.messages[0].id, "review-result-turn-1");
    assert.equal(hydrated.messages[0].text, "有一个高优先级问题。");
  });
});

describe("protocolAdapter approval parsing", () => {
  it("recognizes every supported approval family", () => {
    const cases = [
      ["item/commandExecution/requestApproval", "commandApproval", { command: "echo ok" }],
      ["item/fileChange/requestApproval", "fileApproval", { grantRoot: "C:\\work" }],
      ["item/permissions/requestApproval", "permissionsApproval", { permissions: { network: true } }],
      ["tool/requestUserInput", "userInput", { questions: [{ id: "q1", question: "Continue?" }] }],
      ["mcpServer/elicitation/request", "elicitation", { mode: "form", serverName: "demo" }],
    ] as const;

    for (const [method, kind, params] of cases) {
      const applied = applyServerMessage(emptySession(`session-${kind}`, "C:\\work"), {
        id: `request-${kind}`,
        method,
        params: { threadId: "thread-1", ...params },
      });
      assert.equal(applied.approval?.kind, kind);
    }
  });
});
