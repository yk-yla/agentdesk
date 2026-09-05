import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEventEnvelope, AgentProvider, AgentRequestContext, InteractionRef } from "../../shared/agentProtocol";
import { encodeCodexRpcError } from "../../shared/protocol";
import { canonicalPath } from "../localPathPolicy";
import { AgentSessionRegistry } from "./agentSessionRegistry";
import { NativeSessionOwnershipRegistry } from "./nativeSessionOwnershipRegistry";

const cwd = canonicalPath(process.cwd());
const otherCwd = canonicalPath(`${process.cwd()}-other`);

function registry(nativeOwnership = new NativeSessionOwnershipRegistry()) {
  return new AgentSessionRegistry((value) => canonicalPath(value) === cwd, nativeOwnership);
}

function context(overrides: Partial<AgentRequestContext> = {}): AgentRequestContext {
  return { sessionId: "client-1", canonicalCwd: cwd, queryGeneration: 0, ...overrides };
}

function event(provider: AgentProvider, type: string, payload: unknown, extra: Partial<AgentEventEnvelope> = {}): AgentEventEnvelope {
  return { provider, type, payload, receivedAt: Date.now(), ...extra };
}

function startSession(sessions: AgentSessionRegistry, provider: AgentProvider = "codex") {
  sessions.prepareRequest(provider, "startSession", { cwd }, context());
  sessions.completeRequest(provider, "startSession", { cwd }, context(), { thread: { id: "thread-1", cwd } });
}

describe("AgentSessionRegistry", () => {
  it("requires a main-process authorized workspace and rejects duplicate client sessions", () => {
    const sessions = registry();
    assert.throws(() => sessions.prepareRequest("codex", "startSession", { cwd: otherCwd }, context({ canonicalCwd: otherCwd })), /未经过主进程授权/);
    startSession(sessions);
    assert.throws(() => sessions.prepareRequest("codex", "startSession", { cwd }, context()), /不能重复启动/);
  });

  it("rejects cross-provider, cross-workspace, cross-thread and stale query requests", () => {
    const sessions = registry();
    startSession(sessions);
    assert.throws(() => sessions.prepareRequest("claude", "startTurn", { threadId: "thread-1" }, context({ nativeSessionId: "thread-1" })), /Provider 归属不匹配/);
    assert.throws(() => sessions.prepareRequest("codex", "startTurn", { cwd: otherCwd, threadId: "thread-1" }, context({ nativeSessionId: "thread-1" })), /工作区归属不匹配/);
    assert.throws(() => sessions.prepareRequest("codex", "startTurn", { threadId: "thread-2" }, context({ nativeSessionId: "thread-1" })), /原生会话归属不匹配/);
    sessions.observeEvent(event("codex", "turn/started", { threadId: "thread-1", turn: { id: "turn-1" } }));
    assert.throws(() => sessions.prepareRequest("codex", "interruptTurn", { threadId: "thread-1" }, context({ nativeSessionId: "thread-1", queryGeneration: 0 })), /Query 代次已失效/);
  });

  it("allows stale-generation cleanup while keeping regular requests strict", () => {
    const sessions = registry();
    startSession(sessions);
    sessions.observeEvent(event("codex", "turn/started", { threadId: "thread-1", turn: { id: "turn-1" } }));
    const staleContext = context({ nativeSessionId: "thread-1", queryGeneration: 0 });
    assert.throws(() => sessions.prepareRequest("codex", "interruptTurn", { threadId: "thread-1" }, staleContext), /Query 代次已失效/);
    assert.doesNotThrow(() => sessions.prepareRequest("codex", "closeSession", {}, staleContext));
  });

  it("keeps Codex session registrations after a non-fatal client error", () => {
    const sessions = registry();
    startSession(sessions);

    sessions.observeEvent(event("codex", "client/error", { threadId: "thread-1", message: "request failed" }));

    sessions.prepareRequest("codex", "startTurn", { threadId: "thread-1" }, context({ nativeSessionId: "thread-1" }));
  });

  it("bounds generated title conversation input by UTF-8 bytes", () => {
    const sessions = registry();
    startSession(sessions);
    const titleContext = context({ nativeSessionId: "thread-1" });
    sessions.prepareRequest("codex", "generateSessionTitle", { threadId: "thread-1", conversation: "a".repeat(48 * 1024) }, titleContext);
    assert.throws(() => sessions.prepareRequest("codex", "generateSessionTitle", { threadId: "thread-1", conversation: "你".repeat(48 * 1024) }, titleContext), /内容无效或过大/);
  });

  it("clears Codex session registrations only after the app-server exits", () => {
    const sessions = registry();
    startSession(sessions);

    sessions.observeEvent(event("codex", "client/server-exited", { code: 1 }));

    assert.throws(() => sessions.prepareRequest("codex", "startTurn", { threadId: "thread-1" }, context({ nativeSessionId: "thread-1" })), /会话不存在/);
  });

  it("keeps other Codex registrations when an isolated session service exits", () => {
    const sessions = registry();
    startSession(sessions);
    sessions.prepareRequest("codex", "startSession", { cwd }, context({ sessionId: "client-2" }));
    sessions.completeRequest("codex", "startSession", { cwd }, context({ sessionId: "client-2" }), { thread: { id: "thread-2", cwd } });

    sessions.observeEvent(event("codex", "client/server-exited", { code: 1 }, { sessionId: "client-1" }));

    assert.throws(() => sessions.prepareRequest("codex", "startTurn", { threadId: "thread-1" }, context({ nativeSessionId: "thread-1" })), /会话不存在/);
    assert.doesNotThrow(() => sessions.prepareRequest("codex", "startTurn", { threadId: "thread-2" }, context({ sessionId: "client-2", nativeSessionId: "thread-2" })));
  });

  it("rejects Renderer trust and dangerous Codex overrides recursively", () => {
    const sessions = registry();
    assert.throws(() => sessions.prepareRequest("claude", "startSession", { cwd, trustWorkspace: true }, context()), /不能自行授予/);
    assert.throws(() => sessions.prepareRequest("codex", "startSession", { cwd, nested: { sandboxPolicy: { type: "dangerFullAccess" } } }, context()), /安全参数不允许/);
  });

  it("allows deletion only through the matching short-lived close grant", () => {
    const sessions = registry();
    startSession(sessions);
    sessions.prepareRequest("codex", "closeSession", {}, context({ nativeSessionId: "thread-1" }));
    sessions.completeRequest("codex", "closeSession", {}, context({ nativeSessionId: "thread-1" }), undefined);
    assert.throws(() => sessions.prepareRequest("codex", "deleteSession", { threadId: "thread-2" }, context({ nativeSessionId: "thread-2" })), /删除授权归属不匹配/);
    sessions.prepareRequest("codex", "deleteSession", { threadId: "thread-1" }, context({ nativeSessionId: "thread-1" }));
    sessions.completeRequest("codex", "deleteSession", { threadId: "thread-1" }, context({ nativeSessionId: "thread-1" }), { ok: true });
    assert.throws(() => sessions.prepareRequest("codex", "deleteSession", { threadId: "thread-1" }, context({ nativeSessionId: "thread-1" })), /不存在或已过期/);
  });

  it("verifies unknown reads and tracks sessionless fork and delete ownership", () => {
    const sessions = registry();
    sessions.prepareRequest("codex", "readSession", { cwd, threadId: "history-1" }, { canonicalCwd: cwd, nativeSessionId: "history-1" });
    assert.throws(() => sessions.completeRequest("codex", "readSession", { cwd, threadId: "history-1" }, { canonicalCwd: cwd, nativeSessionId: "history-1" }, { thread: { id: "history-1", cwd: otherCwd } }), /归属无效/);
    sessions.completeRequest("codex", "readSession", { cwd, threadId: "history-1" }, { canonicalCwd: cwd, nativeSessionId: "history-1" }, { thread: { id: "history-1", cwd } });
    sessions.prepareRequest("codex", "renameSession", { cwd, threadId: "history-1", name: "renamed" }, { canonicalCwd: cwd, nativeSessionId: "history-1" });
    sessions.prepareRequest("codex", "forkSession", { cwd, threadId: "history-1" }, { canonicalCwd: cwd, nativeSessionId: "history-1" });
    sessions.completeRequest("codex", "forkSession", { cwd, threadId: "history-1" }, { canonicalCwd: cwd, nativeSessionId: "history-1" }, { thread: { id: "history-fork", cwd } });
    sessions.prepareRequest("codex", "renameSession", { cwd, threadId: "history-fork", name: "forked" }, { canonicalCwd: cwd, nativeSessionId: "history-fork" });
    sessions.prepareRequest("codex", "deleteSession", { cwd, threadId: "history-1" }, { canonicalCwd: cwd, nativeSessionId: "history-1" });
    sessions.completeRequest("codex", "deleteSession", { cwd, threadId: "history-1" }, { canonicalCwd: cwd, nativeSessionId: "history-1" }, {});
    assert.throws(() => sessions.prepareRequest("codex", "renameSession", { cwd, threadId: "history-1", name: "deleted" }, { canonicalCwd: cwd, nativeSessionId: "history-1" }), /尚未由当前工作区/);
    sessions.prepareRequest("codex", "listSessions", { cwd }, { canonicalCwd: cwd });
    sessions.completeRequest("codex", "listSessions", { cwd }, { canonicalCwd: cwd }, { data: [{ id: "history-1", cwd }] });
    sessions.prepareRequest("codex", "readSession", { cwd, threadId: "history-1" }, { canonicalCwd: cwd });
  });

  it("validates unscoped paginated history ownership", () => {
    const sessions = registry();
    sessions.prepareRequest("codex", "readSessionPage", { cwd, threadId: "history-page" }, { canonicalCwd: cwd });
    assert.throws(() => sessions.completeRequest("codex", "readSessionPage", { cwd, threadId: "history-page" }, { canonicalCwd: cwd }, {
      thread: { id: "history-page", cwd: otherCwd },
      nextCursor: null,
    }), /归属无效/);
    sessions.completeRequest("codex", "readSessionPage", { cwd, threadId: "history-page" }, { canonicalCwd: cwd }, {
      thread: { id: "history-page", cwd },
      nextCursor: null,
    });
  });

  it("allows only explicit unscoped history requests without granting returned workspaces", () => {
    const sessions = registry();
    assert.throws(() => sessions.prepareRequest("codex", "listSessions", {}, {}), /缺少工作区/);
    assert.throws(() => sessions.prepareRequest("claude", "searchSessions", { allWorkspaces: true, cwd, searchTerm: "x" }, {}), /不能绑定单个工作区/);

    sessions.prepareRequest("codex", "listSessions", { allWorkspaces: true }, {});
    sessions.completeRequest("codex", "listSessions", { allWorkspaces: true }, {}, { data: [{ id: "global-known", cwd }, { id: "global-other", cwd: otherCwd }] });
    sessions.prepareRequest("codex", "readSession", { cwd, threadId: "global-known" }, { canonicalCwd: cwd });
    assert.throws(() => sessions.prepareRequest("codex", "readSession", { cwd: otherCwd, threadId: "global-other" }, { canonicalCwd: otherCwd }), /未经过主进程授权/);
  });

  it("binds Codex interactions to the active tab, query and request once", () => {
    const sessions = registry();
    startSession(sessions);
    sessions.observeEvent(event("codex", "turn/started", { threadId: "thread-1", turn: { id: "turn-1" } }));
    sessions.observeEvent(event("codex", "item/commandExecution/requestApproval", { threadId: "thread-1" }, { requestId: 7 }));
    const valid: InteractionRef = { provider: "codex", sessionId: "client-1", queryGeneration: 1, interactionId: "7", requestId: 7 };
    assert.throws(() => sessions.prepareResponse({ ...valid, sessionId: "other-tab" }), /归属不匹配/);
    assert.throws(() => sessions.prepareResponse({ ...valid, queryGeneration: 0 }), /归属不匹配/);
    assert.throws(() => sessions.prepareResponse({ ...valid, requestId: 8 }), /不存在或已过期/);
    sessions.prepareResponse(valid);
    assert.throws(() => sessions.prepareResponse(valid), /不能重复响应/);
    sessions.completeResponse(valid, true);
    assert.throws(() => sessions.prepareResponse(valid), /不存在或已过期/);
  });

  it("keeps identical interaction ids isolated between Codex pages", () => {
    const sessions = registry();
    startSession(sessions);
    sessions.prepareRequest("codex", "startSession", { cwd }, context({ sessionId: "client-2" }));
    sessions.completeRequest("codex", "startSession", { cwd }, context({ sessionId: "client-2" }), { thread: { id: "thread-2", cwd } });
    sessions.observeEvent(event("codex", "turn/started", { threadId: "thread-1", turn: { id: "turn-1" } }));
    sessions.observeEvent(event("codex", "turn/started", { threadId: "thread-2", turn: { id: "turn-2" } }));
    sessions.observeEvent(event("codex", "tool/requestUserInput", { threadId: "thread-1" }, { requestId: 7 }));
    sessions.observeEvent(event("codex", "tool/requestUserInput", { threadId: "thread-2" }, { requestId: 7 }));

    const first: InteractionRef = { provider: "codex", sessionId: "client-1", queryGeneration: 1, interactionId: "7", requestId: 7 };
    const second: InteractionRef = { provider: "codex", sessionId: "client-2", queryGeneration: 1, interactionId: "7", requestId: 7 };
    sessions.prepareResponse(first);
    sessions.completeResponse(first, true);
    assert.doesNotThrow(() => sessions.prepareResponse(second));
  });

  it("expires Codex interactions when the query finishes", () => {
    const sessions = registry();
    startSession(sessions);
    sessions.observeEvent(event("codex", "turn/started", { threadId: "thread-1", turn: { id: "turn-1" } }));
    sessions.observeEvent(event("codex", "tool/requestUserInput", { threadId: "thread-1" }, { requestId: "question" }));
    sessions.observeEvent(event("codex", "turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }));
    assert.throws(() => sessions.prepareResponse({ provider: "codex", sessionId: "client-1", queryGeneration: 1, interactionId: "question", requestId: "question" }), /不存在或已过期/);
  });

  it("keeps a timed-out Codex start pending until the late response settles it", () => {
    const sessions = registry();
    sessions.prepareRequest("codex", "startSession", { cwd }, context());
    sessions.failRequest("codex", "startSession", context(), new Error(encodeCodexRpcError({
      method: "startSession",
      message: "timeout",
      data: { kind: "requestTimeout", backgroundMayContinue: true },
    })));
    assert.throws(() => sessions.prepareRequest("codex", "startSession", { cwd }, context()), /不能重复启动/);
    sessions.observeEvent(event("codex", "client/late-response", {
      sessionId: "client-1",
      requestMethod: "thread/start",
      response: { result: { thread: { id: "thread-late", cwd } } },
    }));
    sessions.prepareRequest("codex", "startTurn", { threadId: "thread-late" }, context({ nativeSessionId: "thread-late" }));
  });

  it("rejects a second workbench recovery while another tab owns the native session", () => {
    const ownership = new NativeSessionOwnershipRegistry();
    const sessions = registry(ownership);
    ownership.claim("codex", "thread-owned", "other-tab");
    assert.throws(() => sessions.prepareRequest("codex", "resumeSession", { cwd, threadId: "thread-owned" }, context()), /占用/);
  });

  it("releases workbench ownership when the session closes", () => {
    const ownership = new NativeSessionOwnershipRegistry();
    const sessions = registry(ownership);
    startSession(sessions);
    assert.equal(ownership.owner("codex", "thread-1")?.clientSessionId, "client-1");
    sessions.prepareRequest("codex", "closeSession", {}, context({ nativeSessionId: "thread-1" }));
    sessions.completeRequest("codex", "closeSession", {}, context({ nativeSessionId: "thread-1" }), undefined);
    ownership.claim("codex", "thread-1", "other-tab");
  });
});
