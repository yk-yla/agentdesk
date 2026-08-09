import type { AgentOperation, AgentProvider } from "../../shared/agentProtocol";
import type { JsonObject } from "../../shared/protocol";

type StartTurnPreparer = (params: JsonObject) => JsonObject;

interface MainProviderRequestAdapter {
  prepare(operation: AgentOperation, params: JsonObject, prepareStartTurn: StartTurnPreparer): JsonObject;
}

const adapters: Record<AgentProvider, MainProviderRequestAdapter> = {
  codex: { prepare: (_operation, params) => params },
  claude: { prepare: (operation, params, prepareStartTurn) => operation === "startTurn" ? prepareStartTurn(params) : params },
};

export function prepareAgentRequest(provider: AgentProvider, operation: AgentOperation, params: JsonObject, prepareStartTurn: StartTurnPreparer) {
  return adapters[provider].prepare(operation, params, prepareStartTurn);
}

