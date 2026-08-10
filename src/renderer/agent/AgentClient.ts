import type { AgentEventEnvelope, AgentOperation, AgentProvider, AgentRequestContext, InteractionRef } from "../../shared/agentProtocol";
import type { AgentBridge, JsonObject } from "../../shared/protocol";

export class AgentClient {
  constructor(readonly bridge: AgentBridge) {}

  request(provider: AgentProvider, operation: AgentOperation, params: JsonObject = {}, context: AgentRequestContext = {}) {
    const requestId = `${provider}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    void this.bridge.writeLog({ level: "info", event: "renderer.agent_request.started", details: { requestId, provider, operation, params, context: { ...context, requestId } } }).catch(() => undefined);
    return this.bridge.agentRequest(provider, operation, params, { ...context, requestId }).then((result) => {
      void this.bridge.writeLog({ level: "info", event: "renderer.agent_request.completed", details: { requestId, provider, operation, durationMs: Date.now() - startedAt, result } }).catch(() => undefined);
      return result;
    }, (error) => {
      void this.bridge.writeLog({ level: "error", event: "renderer.agent_request.failed", details: { requestId, provider, operation, durationMs: Date.now() - startedAt, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) } } }).catch(() => undefined);
      throw error;
    });
  }

  respond(ref: InteractionRef, result: JsonObject) {
    void this.bridge.writeLog({ level: "info", event: "renderer.interaction_response.started", details: { ref, result } }).catch(() => undefined);
    return this.bridge.respondToInteraction({ ref, result }).then((value) => {
      void this.bridge.writeLog({ level: "info", event: "renderer.interaction_response.completed", details: { ref } }).catch(() => undefined);
      return value;
    }, (error) => {
      void this.bridge.writeLog({ level: "error", event: "renderer.interaction_response.failed", details: { ref, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) } } }).catch(() => undefined);
      throw error;
    });
  }

  onEvent(listener: (event: AgentEventEnvelope) => void) {
    return this.bridge.onAgentEvent(listener);
  }
}
