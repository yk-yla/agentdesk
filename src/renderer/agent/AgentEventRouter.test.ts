import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEventEnvelope } from "../../shared/agentProtocol";
import { emptySession } from "../domain";
import { applyAgentEvent, routeAgentEvent } from "./AgentEventRouter";

function envelope(type: string, payload: unknown): AgentEventEnvelope {
  return { provider: "codex", receivedAt: Date.now(), type, payload };
}

describe("AgentEventRouter Codex adapter", () => {
  it("extracts the native session and lifecycle state", () => {
    const routed = routeAgentEvent(envelope("turn/completed", { threadId: "thread-1", turn: { status: "interrupted" } }));
    assert.equal(routed.provider, "codex");
    assert.equal(routed.nativeSessionId, "thread-1");
    assert.equal(routed.kind, "turnCompleted");
    assert.equal(routed.turnStatus, "interrupted");
    assert.equal(routed.lifecycle, true);
  });

  it("writes the main-process Codex query generation back to the session", () => {
    const source = emptySession("session", "C:\\workspace", "", "", "codex");
    const routed = routeAgentEvent({ ...envelope("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } }), queryGeneration: 3 });
    assert.equal(applyAgentEvent(source, routed).session.queryGeneration, 3);
  });

  it("maps late response method names to neutral operations", () => {
    const routed = routeAgentEvent(envelope("client/late-response", {
      sessionId: "ui-1", requestMethod: "thread/start", response: { result: { thread: { id: "thread-2" } } },
    }));
    assert.equal(routed.kind, "lateResponse");
    assert.equal(routed.clientSessionId, "ui-1");
    assert.equal(routed.lateResponse?.operation, "startSession");
  });

  it("does not treat a non-fatal Codex client error as a backend exit", () => {
    assert.equal(routeAgentEvent(envelope("client/error", { message: "request failed" })).kind, "state");
    assert.equal(routeAgentEvent(envelope("client/server-exited", { code: 1 })).kind, "backendExited");
  });
});
