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
  it("passes Codex turn parameters through without overriding config.toml", async () => {
    let called = "";
    let providerParams = {};
    const backend = new CodexBackend(runtime({ request: async (method, params) => { called = method; providerParams = params; return { ok: true }; } }));
    assert.deepEqual(await backend.request("startTurn", {}, { sessionId: "ui-1" }), { ok: true });
    assert.equal(called, "turn/start");
    assert.deepEqual(providerParams, {});

    await backend.request("startTurn", { cwd: "E:\\workspace" }, { sessionId: "ui-1" });
    assert.deepEqual(providerParams, { cwd: "E:\\workspace" });

    await backend.request("startReview", {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    }, { sessionId: "ui-1" });
    assert.deepEqual(providerParams, {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
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
});
