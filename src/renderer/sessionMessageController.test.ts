import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentOperation } from "../shared/agentProtocol";
import type { JsonObject } from "../shared/protocol";
import { CODEX_CAPABILITIES, emptySession, type ImageAttachment, type PendingSteerMessage, type QueuedMessage, type SessionState } from "./domain";
import { CodexRequestError } from "./inputQueue";
import { SessionMessageController } from "./sessionMessageController";

type RequestHandler = (operation: AgentOperation, params: JsonObject) => Promise<unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("异步状态未在预期时间内收敛");
}

function createHarness(requestHandler?: RequestHandler) {
  const session = emptySession("session", "D:\\work", "model", "medium");
  session.capabilities = { ...CODEX_CAPABILITIES };
  const sessions: Record<string, SessionState> = { session };
  const queued: Record<string, QueuedMessage[]> = {};
  const pending: Record<string, PendingSteerMessage[]> = {};
  const attachments: Record<string, ImageAttachment[]> = {};
  const requests: Array<{ operation: AgentOperation; params: JsonObject }> = [];
  const restored: QueuedMessage[][] = [];
  const history: Array<{ id: string; title: string }> = [];
  const statusCalls: string[] = [];
  const mcpCalls: string[] = [];
  const clearCalls: string[] = [];
  const commandUseCalls: string[] = [];
  let now = 1_000;

  const controller = new SessionMessageController({
    state: {
      getSession: (sessionId) => sessions[sessionId],
      getQueued: (sessionId) => queued[sessionId] || [],
      getPendingSteers: (sessionId) => pending[sessionId] || [],
      getAttachments: (sessionId) => attachments[sessionId] || [],
      getSkills: () => [{ name: "deploy", description: "部署", path: "D:\\skills\\deploy\\SKILL.md", scope: "user", enabled: true }],
      updateSession: (sessionId, updater) => { if (sessions[sessionId]) sessions[sessionId] = updater(sessions[sessionId]); },
      replaceQueued: (sessionId, next) => { queued[sessionId] = typeof next === "function" ? next(queued[sessionId] || []) : next; },
      replacePendingSteers: (sessionId, next) => { pending[sessionId] = typeof next === "function" ? next(pending[sessionId] || []) : next; },
      replaceAttachments: (sessionId, next) => { attachments[sessionId] = typeof next === "function" ? next(attachments[sessionId] || []) : next; },
    },
    services: {
      request: async (_sessionId, operation, params) => {
        requests.push({ operation, params });
        if (requestHandler) return requestHandler(operation, params);
        if (operation === "startTurn") return { turn: { id: "turn-1" } };
        return {};
      },
      ensureThread: async (sessionId) => {
        sessions[sessionId] = { ...sessions[sessionId], threadId: sessions[sessionId].threadId || "thread-1" };
        return sessions[sessionId].threadId as string;
      },
      clearSession: (sessionId) => { clearCalls.push(sessionId); },
      restoreMessagesToDraft: (_sessionId, messages) => { restored.push(messages); },
      showStatus: async (sessionId) => { statusCalls.push(sessionId); },
      showMcpStatus: async (sessionId) => { mcpCalls.push(sessionId); },
      rememberCommandUse: (key) => { commandUseCalls.push(key); },
      upsertHistory: (entry) => { history.push({ id: entry.id, title: entry.title }); },
      now: () => { now += 1; return now; },
    },
  });

  return { controller, sessions, queued, pending, attachments, requests, restored, history, statusCalls, mcpCalls, clearCalls, commandUseCalls };
}

function message(id: string, text: string, queueKind: QueuedMessage["queueKind"] = "explicit"): QueuedMessage {
  return { id, clientUserMessageId: `client-${id}`, text, images: [], queueKind, sequence: Number(id.replace(/\D/g, "")) || 1 };
}

describe("SessionMessageController", () => {
  it("does not submit or queue messages for a read-only session", async () => {
    const harness = createHarness();
    harness.sessions.session.readOnly = true;

    harness.controller.sendMessage("session", "should stay local");
    await harness.controller.runMessage("session", message("input-1", "should stay local")).then((accepted) => assert.equal(accepted, false));

    assert.equal(harness.requests.length, 0);
    assert.equal(harness.sessions.session.messages.length, 0);
    assert.match(harness.sessions.session.errorText, /只读模式/);
  });

  it("switches to read-only when a turn discovers an external writer", async () => {
    const harness = createHarness(async (operation) => {
      if (operation === "startTurn") throw new CodexRequestError({ method: "startTurn", message: "thread thread-1 already has an active writer" });
      return {};
    });

    harness.controller.sendMessage("session", "blocked by bridge");
    await waitFor(() => harness.sessions.session.readOnly === true);

    assert.equal(harness.sessions.session.status, "error");
    assert.equal(harness.sessions.session.messages.length, 0);
    assert.match(harness.sessions.session.errorText, /只读模式/);
  });

  it("sends a normal message, consumes attachments, and updates the active turn", async () => {
    const harness = createHarness();
    harness.attachments.session = [{ path: "D:\\image.png", dataUrl: "data:image/png;base64,eA==", name: "image.png" }];

    harness.controller.sendMessage("session", "inspect this");
    await waitFor(() => harness.requests.length === 1);

    assert.equal(harness.requests[0].operation, "startTurn");
    assert.equal(harness.attachments.session.length, 0);
    assert.equal(harness.sessions.session.messages[0].text, "inspect this");
    assert.equal(harness.sessions.session.messages[0].timestamp, 1002);
    assert.equal(harness.sessions.session.activeTurnId, "turn-1");
    assert.equal(harness.sessions.session.statusLabel, "工作中");
    assert.deepEqual(harness.history, [{ id: "thread-1", title: "inspect this" }]);
  });

  it("does not replace a manual title that happens to be the placeholder text", async () => {
    const harness = createHarness();
    harness.sessions.session = { ...harness.sessions.session, title: "新会话", titleOrigin: "manual" };

    harness.controller.sendMessage("session", "keep the chosen title");
    await waitFor(() => harness.requests.length === 1);

    assert.equal(harness.sessions.session.title, "新会话");
    assert.equal(harness.sessions.session.titleOrigin, "manual");
  });

  it("runs local status and clear commands without starting a turn", async () => {
    const harness = createHarness();

    harness.controller.sendMessage("session", "/status");
    harness.controller.sendMessage("session", "/clear");
    await waitFor(() => harness.statusCalls.length === 1);

    assert.deepEqual(harness.statusCalls, ["session"]);
    assert.deepEqual(harness.clearCalls, ["session"]);
    assert.deepEqual(harness.commandUseCalls, ["command:status", "command:clear"]);
    assert.equal(harness.requests.length, 0);
  });

  it("records skill use when the skill is submitted", async () => {
    const harness = createHarness();

    harness.controller.sendMessage("session", "/deploy production");
    await waitFor(() => harness.requests.length === 1);

    assert.deepEqual(harness.commandUseCalls, ["skill:deploy"]);
    assert.equal(harness.requests[0].operation, "startTurn");
  });

  it("keeps a timed-out start request as an accepted background turn", async () => {
    const harness = createHarness(async (operation) => {
      if (operation === "startTurn") {
        throw new CodexRequestError({ method: "startTurn", message: "timeout", data: { kind: "requestTimeout" } });
      }
      return {};
    });

    const accepted = await harness.controller.runMessage("session", message("1", "slow task"));

    assert.equal(accepted, true);
    assert.equal(harness.sessions.session.status, "working");
    assert.equal(harness.sessions.session.statusLabel, "响应超时，后台状态待确认");
    assert.equal(harness.sessions.session.messages.length, 1);
    assert.deepEqual(harness.history, [{ id: "thread-1", title: "slow task" }]);
  });

  it("serializes steer requests so later input cannot overtake earlier input", async () => {
    const firstRequest = deferred<unknown>();
    let steerCalls = 0;
    const harness = createHarness(async (operation) => {
      if (operation !== "steerTurn") return {};
      steerCalls += 1;
      return steerCalls === 1 ? firstRequest.promise : {};
    });
    harness.sessions.session = { ...harness.sessions.session, threadId: "thread", activeTurnId: "turn", status: "working" };

    harness.controller.sendMessage("session", "first");
    harness.controller.sendMessage("session", "second");
    await waitFor(() => steerCalls === 1);
    assert.equal(steerCalls, 1);

    firstRequest.resolve({});
    await waitFor(() => steerCalls === 2);
    assert.equal(harness.pending.session.length, 2);
  });

  it("retries a steer with the server turn id and queues a non-steerable request", async () => {
    const turnIds: unknown[] = [];
    let calls = 0;
    const harness = createHarness(async (operation, params) => {
      if (operation !== "steerTurn") return {};
      calls += 1;
      turnIds.push(params.expectedTurnId);
      if (calls === 1) throw new CodexRequestError({ method: "steerTurn", message: "expected active turn id `old` but found `new`" });
      if (calls === 2) return {};
      throw new CodexRequestError({ method: "steerTurn", message: "cannot steer a review turn" });
    });
    harness.sessions.session = { ...harness.sessions.session, threadId: "thread", activeTurnId: "old", status: "working" };

    harness.controller.sendMessage("session", "retry with new turn");
    await waitFor(() => calls === 2);
    assert.deepEqual(turnIds, ["old", "new"]);
    assert.equal(harness.sessions.session.activeTurnId, "new");

    harness.controller.sendMessage("session", "queue rejected steer");
    await waitFor(() => calls === 3);
    assert.equal(harness.pending.session.length, 1);
    assert.equal(harness.queued.session[0].text, "queue rejected steer");
    assert.equal(harness.queued.session[0].queueKind, "rejectedSteer");
  });

  it("drains rejected steers as one message before the explicit FIFO queue", async () => {
    const sentTexts: string[] = [];
    const harness = createHarness(async (operation, params) => {
      if (operation === "startTurn") {
        const input = params.input as Array<{ type: string; text?: string }>;
        sentTexts.push(input.find((entry) => entry.type === "text")?.text || "");
        return { turn: { id: `turn-${sentTexts.length}` } };
      }
      return {};
    });
    harness.queued.session = [message("1", "rejected one", "rejectedSteer"), message("2", "explicit", "explicit"), message("3", "rejected two", "rejectedSteer")];

    await harness.controller.drainQueues(["session"]);

    assert.deepEqual(sentTexts, ["rejected one\nrejected two"]);
    assert.deepEqual(harness.queued.session.map((entry) => entry.text), ["explicit"]);
  });

  it("retries interrupt with the latest turn id and resubmits pending steers", async () => {
    const turnIds: unknown[] = [];
    const harness = createHarness(async (operation, params) => {
      if (operation !== "interruptTurn") return {};
      turnIds.push(params.turnId);
      if (turnIds.length === 1) throw new CodexRequestError({ method: "interruptTurn", message: "expected active turn id old but found new" });
      return {};
    });
    harness.sessions.session = { ...harness.sessions.session, threadId: "thread", activeTurnId: "old", status: "working" };
    harness.pending.session = [{ ...message("1", "pending steer"), clientUserMessageId: "client-1", expectedTurnId: "old" }];

    assert.equal(await harness.controller.interrupt("session"), true);
    harness.controller.handleTurnCompleted("session", "interrupted");

    assert.deepEqual(turnIds, ["old", "new"]);
    assert.equal(harness.pending.session.length, 0);
    assert.equal(harness.queued.session[0].queueKind, "rejectedSteer");
    assert.equal(harness.restored.length, 0);
  });

  it("restores all unsent messages when interruption was not requested locally", () => {
    const harness = createHarness();
    harness.pending.session = [{ ...message("2", "pending"), clientUserMessageId: "client-2", expectedTurnId: "turn" }];
    harness.queued.session = [message("1", "rejected", "rejectedSteer"), message("3", "explicit")];

    harness.controller.handleTurnCompleted("session", "interrupted");

    assert.deepEqual(harness.restored[0].map((entry) => entry.text), ["rejected", "pending", "explicit"]);
    assert.equal(harness.pending.session.length, 0);
    assert.equal(harness.queued.session.length, 0);
  });
});
