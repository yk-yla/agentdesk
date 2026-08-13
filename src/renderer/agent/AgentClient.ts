import type { AgentEventEnvelope, AgentOperation, AgentProvider, AgentRequestContext, InteractionRef } from "../../shared/agentProtocol";
import type { AgentBridge, JsonObject } from "../../shared/protocol";

export class AgentClient {
  constructor(readonly bridge: AgentBridge) {}

  request(provider: AgentProvider, operation: AgentOperation, params: JsonObject = {}, context: AgentRequestContext = {}) {
    const requestId = `${provider}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.bridge.agentRequest(provider, operation, params, { ...context, requestId });
  }

  respond(ref: InteractionRef, result: JsonObject) {
    return this.bridge.respondToInteraction({ ref, result }).then((value) => {
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
