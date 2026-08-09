import type { AgentCapabilities, AgentEventEnvelope, AgentOperation, AgentProvider, AgentRequestContext, InteractionRef } from "../../shared/agentProtocol";
import type { JsonObject } from "../../shared/protocol";

export interface AgentBackend {
  readonly provider: AgentProvider;
  request(operation: AgentOperation, params: JsonObject, context: AgentRequestContext): Promise<unknown>;
  respondToInteraction(ref: InteractionRef, result: JsonObject): Promise<void>;
  subscribeEvents(listener: (event: AgentEventEnvelope) => void): () => void;
  getCapabilities(): Promise<AgentCapabilities>;
  closeSession(context: AgentRequestContext): Promise<void>;
  close(): Promise<void>;
}
