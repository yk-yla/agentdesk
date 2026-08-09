import type { AgentEventEnvelope, AgentOperation, AgentProvider, AgentRequestContext, InteractionRef } from "../../shared/agentProtocol";
import type { AgentBridge, JsonObject } from "../../shared/protocol";

export class AgentClient {
  constructor(readonly bridge: AgentBridge) {}

  request(provider: AgentProvider, operation: AgentOperation, params: JsonObject = {}, context: AgentRequestContext = {}) {
    return this.bridge.agentRequest(provider, operation, params, context);
  }

  respond(ref: InteractionRef, result: JsonObject) {
    return this.bridge.respondToInteraction({ ref, result });
  }

  onEvent(listener: (event: AgentEventEnvelope) => void) {
    return this.bridge.onAgentEvent(listener);
  }
}
