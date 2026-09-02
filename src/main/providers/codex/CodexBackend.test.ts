import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeCodexRpcError, encodeCodexRpcError, type JsonRpcMessage } from "../../../shared/protocol";
import { CodexBackend, type CodexBackendRuntime } from "./CodexBackend";
import type { CodexHistoryIndex } from "./codexHistoryIndex";

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
  it("prepares the isolated home before each Codex request", async () => {
    const calls: string[] = [];
    const backend = new CodexBackend(
      runtime({ request: async (method) => { calls.push(`request:${method}`); return { data: [] }; } }),
      undefined,
      undefined,
      undefined,
      () => { calls.push("prepare"); },
    );

    await backend.request("listSkills", { cwds: ["E:\\workspace"] }, { canonicalCwd: "E:\\workspace" });

    assert.deepEqual(calls, ["prepare", "request:skills/list"]);
  });

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

  it("forwards native collaboration mode settings without rewriting them", async () => {
    let method = "";
    let providerParams = {};
    const backend = new CodexBackend(runtime({ request: async (value, params) => { method = value; providerParams = params; return {}; } }));
    const collaborationMode = {
      mode: "plan",
      settings: { model: "gpt-test", reasoning_effort: "high", developer_instructions: null },
    };

    await backend.request("updateSessionSettings", { threadId: "thread-1", collaborationMode }, { sessionId: "ui-1" });

    assert.equal(method, "thread/settings/update");
    assert.deepEqual(providerParams, { threadId: "thread-1", collaborationMode });
  });

  it("keeps the all-workspace marker inside AgentDesk", async () => {
    let method = "";
    let providerParams = {};
    const backend = new CodexBackend(runtime({ request: async (value, params) => { method = value; providerParams = params; return { data: [] }; } }));
    await backend.request("listSessions", { allWorkspaces: true, limit: 50 }, {});
    assert.equal(method, "thread/list");
    assert.deepEqual(providerParams, { limit: 50 });
  });

  it("reads skills from the default Codex home while keeping the primary runtime isolated", async () => {
    const calls: string[] = [];
    const primary = runtime({
      request: async (method) => {
        calls.push(`primary:${method}`);
        return { data: [] };
      },
    });
    const legacy = runtime({
      request: async (method) => {
        calls.push(`legacy:${method}`);
        return { data: [{ cwd: "D:\\work", skills: [{ name: "global-skill" }] }] };
      },
    });
    const backend = new CodexBackend(primary, undefined, legacy);

    const result = await backend.request("listSkills", { cwds: ["D:\\work"] }, { canonicalCwd: "D:\\work" });

    assert.deepEqual(calls, ["legacy:skills/list"]);
    assert.deepEqual(result, { data: [{ cwd: "D:\\work", skills: [{ name: "global-skill" }] }] });
  });

  it("keeps independent pagination cursors when merging AgentDesk and default-home history", async () => {
    const calls: string[] = [];
    const primary = runtime({
      request: async (_method, params) => {
        calls.push(`primary:${String(params.cursor)}`);
        return params.cursor ? { data: [{ id: "primary-2", updatedAt: 2 }], nextCursor: null } : { data: [{ id: "primary-1", updatedAt: 1 }], nextCursor: "primary-next" };
      },
    });
    const legacy = runtime({
      request: async (_method, params) => {
        calls.push(`legacy:${String(params.cursor)}`);
        return params.cursor ? { data: [{ id: "legacy-2", updatedAt: 4 }], nextCursor: null } : { data: [{ id: "legacy-1", updatedAt: 3 }], nextCursor: "legacy-next" };
      },
    });
    const backend = new CodexBackend(primary, undefined, legacy);

    const first = await backend.request("listSessions", { allWorkspaces: true, limit: 10 }, {});
    assert.deepEqual(calls, ["primary:null", "legacy:null"]);
    assert.deepEqual((first as { data: unknown[] }).data.map((entry) => (entry as { id: string }).id), ["legacy-1", "primary-1"]);
    const cursor = (first as { nextCursor: string }).nextCursor;
    assert.ok(cursor.includes("primary-next") && cursor.includes("legacy-next"));

    calls.length = 0;
    const second = await backend.request("listSessions", { allWorkspaces: true, cursor, limit: 10 }, {});
    assert.deepEqual(calls, ["primary:primary-next", "legacy:legacy-next"]);
    assert.equal((second as { nextCursor: string | null }).nextCursor, null);
  });

  it("preserves thread/search wrappers while merging history runtimes", async () => {
    const primary = runtime({
      request: async (method) => method === "thread/search"
        ? { data: [{ thread: { id: "primary-search", cwd: "D:\\work", name: "primary" }, snippet: "primary hit" }], nextCursor: null }
        : { data: [] },
    });
    const legacy = runtime({
      request: async (method) => method === "thread/search"
        ? { data: [{ thread: { id: "legacy-search", cwd: "D:\\work", name: "legacy" }, snippet: "legacy hit" }], nextCursor: null }
        : { data: [] },
    });
    const backend = new CodexBackend(primary, undefined, legacy);

    const result = await backend.request("searchSessions", { searchTerm: "hit", cwd: "D:\\work", limit: 10 }, { canonicalCwd: "D:\\work" }) as { data: Array<{ thread: { id: string }; snippet: string }> };
    assert.deepEqual(result.data.map((entry) => `${entry.thread.id}:${entry.snippet}`).sort(), ["legacy-search:legacy hit", "primary-search:primary hit"]);
  });

  it("returns local history when app-server search is unavailable", async () => {
    let receivedParams: Record<string, unknown> | undefined;
    const historyIndex = {
      search: async () => ({
        data: [{ thread: { id: "local-search", cwd: "D:\\work" }, snippet: "local hit" }],
        nextCursor: null,
      }),
    } as unknown as CodexHistoryIndex;
    const backend = new CodexBackend(runtime({ request: async (_method, params) => { receivedParams = params; throw new Error("app-server unavailable"); } }), undefined, undefined, historyIndex);

    const result = await backend.request("searchSessions", { searchTerm: "hit", cwd: "D:\\work", limit: 10 }, { canonicalCwd: "D:\\work" }) as { data: Array<{ thread: { id: string }; snippet: string }> };
    assert.deepEqual(result.data.map((entry) => `${entry.thread.id}:${entry.snippet}`), ["local-search:local hit"]);
    assert.equal(receivedParams?.cursor, undefined);
  });

  it("marks merged history with the Codex Home that owns each thread", async () => {
    const primary = runtime({ request: async () => ({ data: [{ id: "primary-thread", cwd: "D:\\work", updatedAt: 1 }] }) });
    const legacy = runtime({ request: async () => ({ data: [{ id: "legacy-thread", cwd: "D:\\work", updatedAt: 2 }] }) });
    const backend = new CodexBackend(primary, undefined, legacy);

    const result = await backend.request("listSessions", { allWorkspaces: true, limit: 10 }, {}) as { data: Array<Record<string, unknown>> };
    const byId = new Map(result.data.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("primary-thread")?.codexHome, "agentdesk");
    assert.equal(byId.get("legacy-thread")?.codexHome, "default");
  });

  it("marks nested search results with the Codex Home that owns each thread", async () => {
    const primary = runtime({ request: async () => ({ data: [{ thread: { id: "primary-thread", cwd: "D:\\work", updatedAt: 1 }, snippet: "primary" }] }) });
    const legacy = runtime({ request: async () => ({ data: [{ thread: { id: "legacy-thread", cwd: "D:\\work", updatedAt: 2 }, snippet: "legacy" }] }) });
    const backend = new CodexBackend(primary, undefined, legacy);

    const result = await backend.request("searchSessions", { allWorkspaces: true, limit: 10, searchTerm: "thread" }, {}) as { data: Array<Record<string, unknown>> };
    const byId = new Map(result.data.map((entry) => [String((entry.thread as Record<string, unknown>).id), entry]));
    assert.equal((byId.get("primary-thread")?.thread as Record<string, unknown>).codexHome, "agentdesk");
    assert.equal((byId.get("legacy-thread")?.thread as Record<string, unknown>).codexHome, "default");
  });

  it("routes legacy history reads to the default Codex home even with a client session context", async () => {
    const calls: string[] = [];
    const primary = runtime({
      request: async (method) => {
        calls.push(`primary:${method}`);
        return method === "thread/list" ? { data: [] } : { thread: { id: "new-thread", cwd: "D:\\work" } };
      },
    });
    const legacy = runtime({
      request: async (method) => {
        calls.push(`legacy:${method}`);
        return method === "thread/list"
          ? { data: [{ id: "legacy-thread", cwd: "D:\\work", updatedAt: 2 }] }
          : { thread: { id: "legacy-thread", cwd: "D:\\work", turns: [] } };
      },
    });
    const backend = new CodexBackend(primary, undefined, legacy);

    await backend.request("listSessions", { cwd: "D:\\work", limit: 10 }, { canonicalCwd: "D:\\work" });
    await backend.request("readSession", { cwd: "D:\\work", threadId: "legacy-thread", includeTurns: true }, {
      sessionId: "client-session",
      canonicalCwd: "D:\\work",
      nativeSessionId: "legacy-thread",
    });

    assert.deepEqual(calls, ["primary:thread/list", "legacy:thread/list", "legacy:thread/read"]);
  });

  it("keeps every thread-bound operation on the runtime that resumed a legacy session", async () => {
    const calls: string[] = [];
    const primary = runtime({
      request: async (method) => {
        calls.push(`primary:${method}`);
        return method === "thread/list" ? { data: [] } : {};
      },
    });
    const legacy = runtime({
      request: async (method) => {
        calls.push(`legacy:${method}`);
        if (method === "thread/list") return { data: [{ id: "legacy-thread", cwd: "D:\\work" }] };
        if (method === "thread/resume") return { thread: { id: "legacy-thread", cwd: "D:\\work" } };
        return {};
      },
    });
    const backend = new CodexBackend(primary, undefined, legacy);
    const context = { sessionId: "client-session", nativeSessionId: "legacy-thread", canonicalCwd: "D:\\work" };

    await backend.request("listSessions", { allWorkspaces: true, limit: 10 }, {});
    await backend.request("resumeSession", { threadId: "legacy-thread", cwd: "D:\\work" }, context);
    await backend.request("updateSessionSettings", { threadId: "legacy-thread", collaborationMode: { mode: "plan" } }, context);
    await backend.request("startTurn", { threadId: "legacy-thread", input: [] }, context);

    assert.deepEqual(calls, [
      "primary:thread/list",
      "legacy:thread/list",
      "legacy:thread/resume",
      "legacy:thread/settings/update",
      "legacy:turn/start",
    ]);
  });

  it("falls back to the default-home runtime when startup restore runs before history classification", async () => {
    const calls: string[] = [];
    let interactionRuntime = "";
    const primary = runtime({
      request: async (method) => {
        calls.push(`primary:${method}`);
        if (method === "thread/resume") throw new Error(encodeCodexRpcError({ method, code: -32600, message: "no rollout found for thread id legacy-thread" }));
        return {};
      },
      respond: async () => { interactionRuntime = "primary"; },
    });
    const legacy = runtime({
      request: async (method) => {
        calls.push(`legacy:${method}`);
        return method === "thread/resume" ? { thread: { id: "legacy-thread", cwd: "D:\\work" } } : {};
      },
      respond: async () => { interactionRuntime = "legacy"; },
    });
    const backend = new CodexBackend(primary, undefined, legacy);
    const context = { sessionId: "client-session", nativeSessionId: "legacy-thread", canonicalCwd: "D:\\work" };

    await backend.request("resumeSession", { threadId: "legacy-thread", cwd: "D:\\work" }, context);
    await backend.request("updateSessionSettings", { threadId: "legacy-thread", collaborationMode: { mode: "plan" } }, context);
    await backend.respondToInteraction({ provider: "codex", sessionId: "client-session", queryGeneration: 0, interactionId: "interaction", requestId: 7 }, {});

    assert.deepEqual(calls, ["primary:thread/resume", "legacy:thread/resume", "legacy:thread/settings/update"]);
    assert.equal(interactionRuntime, "legacy");
  });

  it("releases legacy history sessions through the default-home runtime", async () => {
    const calls: string[] = [];
    const primary = runtime({
      request: async (method) => {
        calls.push(`primary:${method}`);
        return { data: [{ id: "primary-thread", cwd: "D:\\work" }] };
      },
    });
    const legacy = runtime({
      request: async (method) => {
        calls.push(`legacy:${method}`);
        if (method === "thread/list") return { data: [{ id: "legacy-thread", cwd: "D:\\work" }] };
        return { status: "unsubscribed" };
      },
    });
    const backend = new CodexBackend(primary, undefined, legacy);

    await backend.request("listSessions", { allWorkspaces: true, limit: 10 }, {});
    await backend.closeSession({ sessionId: "client-session", nativeSessionId: "legacy-thread" });

    assert.deepEqual(calls, ["primary:thread/list", "legacy:thread/list", "legacy:thread/unsubscribe"]);
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
