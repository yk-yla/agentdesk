import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeCodexRpcError, encodeCodexRpcError, type JsonRpcMessage } from "../../../shared/protocol";
import { CodexBackend, type CodexBackendRuntime } from "./CodexBackend";

function runtime(overrides: Partial<CodexBackendRuntime> = {}): CodexBackendRuntime {
  return {
    request: async () => null,
    respond: async () => undefined,
    subscribe: () => () => undefined,
    close: async () => undefined,
    ...overrides,
  };
}

describe("CodexBackend", () => {
  it("forces no-approval full-access settings for every Codex thread and turn", async () => {
    let called = "";
    let providerParams = {};
    const backend = new CodexBackend(runtime({ request: async (method, params) => { called = method; providerParams = params; return { ok: true }; } }));
    assert.deepEqual(await backend.request("startTurn", {}, { sessionId: "ui-1" }), { ok: true });
    assert.equal(called, "turn/start");
    assert.deepEqual(providerParams, {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });

    await backend.request("startTurn", {
      cwd: "E:\\workspace",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    }, { sessionId: "ui-1" });
    assert.deepEqual(providerParams, {
      cwd: "E:\\workspace",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });

    await backend.request("startSession", { cwd: "E:\\workspace" }, { sessionId: "ui-1" });
    assert.deepEqual(providerParams, {
      cwd: "E:\\workspace",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  it("keeps rpc errors structured while exposing the neutral operation", async () => {
    const backend = new CodexBackend(runtime({
      request: async () => { throw new Error(encodeCodexRpcError({ method: "turn/start", code: -1, message: "failed" })); },
    }));
    const error = await backend.request("startTurn", {}, {}).then(() => null, (value) => value as Error);
    assert.equal(decodeCodexRpcError(error)?.method, "startTurn");
    assert.equal(decodeCodexRpcError(error)?.message, "failed");
  });

  it("keeps the all-workspace marker inside AgentDesk", async () => {
    let method = "";
    let providerParams = {};
    const backend = new CodexBackend(runtime({ request: async (value, params) => { method = value; providerParams = params; return { data: [] }; } }));
    await backend.request("listSessions", { allWorkspaces: true, limit: 50 }, {});
    assert.equal(method, "thread/list");
    assert.deepEqual(providerParams, { limit: 50 });
  });

  it("wraps server events and validates interaction ownership", async () => {
    let emit: ((message: JsonRpcMessage) => void) | undefined;
    let responseId: number | string | undefined;
    const backend = new CodexBackend(runtime({
      subscribe(listener) { emit = listener; return () => undefined; },
      async respond(id) { responseId = id; },
    }));
    const events: string[] = [];
    backend.subscribeEvents((event) => events.push(`${event.provider}:${event.type}`));
    emit?.({ method: "turn/completed", params: {} });
    assert.deepEqual(events, ["codex:turn/completed"]);
    await backend.respondToInteraction({ provider: "codex", sessionId: "s", queryGeneration: 0, interactionId: "i", requestId: 7 }, {});
    assert.equal(responseId, 7);
    assert.throws(() => backend.respondToInteraction({ provider: "claude", sessionId: "s", queryGeneration: 0, interactionId: "i", requestId: 8 }, {}), /引用无效/);
  });

  it("unsubscribes the native thread before releasing a Codex session", async () => {
    const requests: Array<{ method: string; params: unknown; operation: string }> = [];
    let cancelledSessionId = "";
    const backend = new CodexBackend(runtime({
      request: async (method, params, _context, operation) => {
        requests.push({ method, params, operation });
        return { status: "unsubscribed" };
      },
    }), {
      generate: async () => "",
      cancel: (sessionId: string) => { cancelledSessionId = sessionId; },
      close: async () => undefined,
    } as never);

    await backend.closeSession({ sessionId: "client-1", nativeSessionId: "thread-1" });

    assert.equal(cancelledSessionId, "client-1");
    assert.deepEqual(requests, [{
      method: "thread/unsubscribe",
      params: { threadId: "thread-1" },
      operation: "closeSession",
    }]);
  });

  it("closes app-server for a Codex terminal handoff", async () => {
    let closes = 0;
    const backend = new CodexBackend(runtime({
      request: async () => ({ status: "unsubscribed" }),
      close: async () => { closes += 1; },
    }));

    await backend.prepareTerminalSession({ sessionId: "client-1", nativeSessionId: "thread-1" });

    assert.equal(closes, 1);
  });

  it("lets the manager hand off a shared app-server after idle sessions are checked", async () => {
    let closes = 0;
    const backend = new CodexBackend(runtime({
      request: async () => ({ thread: { id: "thread-1" } }),
      close: async () => { closes += 1; },
    }));
    await backend.request("resumeSession", { threadId: "thread-1", cwd: "D:\\work" }, { sessionId: "other-session" });

    await backend.prepareTerminalSession({ sessionId: "client-1", nativeSessionId: "thread-1" });
    assert.equal(closes, 1);
  });

  it("allows terminal handoff after the tracked workbench session closes", async () => {
    let closes = 0;
    const backend = new CodexBackend(runtime({
      request: async (method) => method === "thread/resume" ? { thread: { id: "thread-1" } } : { status: "unsubscribed" },
      close: async () => { closes += 1; },
    }));
    const context = { sessionId: "client-1", nativeSessionId: "thread-1", canonicalCwd: "D:\\work" };
    await backend.request("resumeSession", { threadId: "thread-1", cwd: "D:\\work" }, context);

    await backend.closeSession(context);
    await backend.prepareTerminalSession(context);

    assert.equal(closes, 1);
  });

  it("does not contact app-server when a Codex session has no native thread", async () => {
    let requests = 0;
    const backend = new CodexBackend(runtime({
      request: async () => { requests += 1; },
    }));

    await backend.closeSession({ sessionId: "client-1" });

    assert.equal(requests, 0);
  });

  it("uses a native Codex name before invoking the title generator", async () => {
    let generated = 0;
    const backend = new CodexBackend(runtime({
      request: async (method) => method === "thread/read" ? { thread: { id: "thread", name: "原生标题" } } : {},
    }), {
      generate: async () => { generated += 1; return "AI 标题"; },
      cancel: () => undefined,
      close: async () => undefined,
    } as never);
    const result = await backend.request("generateSessionTitle", { threadId: "thread", cwd: "D:\\work", conversation: "会话内容" }, { sessionId: "session", nativeSessionId: "thread", canonicalCwd: "D:\\work" });
    assert.deepEqual(result, { title: "原生标题", source: "native" });
    assert.equal(generated, 0);
  });

  it("generates and persists a Codex title when no native name exists", async () => {
    const methods: string[] = [];
    const backend = new CodexBackend(runtime({
      request: async (method) => {
        methods.push(method);
        return method === "thread/read" ? { thread: { id: "thread" } } : {};
      },
    }), {
      generate: async () => "AI 标题",
      cancel: () => undefined,
      close: async () => undefined,
    } as never);
    const result = await backend.request("generateSessionTitle", { threadId: "thread", cwd: "D:\\work", conversation: "会话内容" }, { sessionId: "session", nativeSessionId: "thread", canonicalCwd: "D:\\work" });
    assert.deepEqual(result, { title: "AI 标题", source: "generated" });
    assert.deepEqual(methods, ["thread/read", "thread/read", "thread/name/set"]);
  });
});
