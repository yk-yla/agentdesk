import type { AgentCapabilities, AgentProvider } from "../shared/agentProtocol";

export type ProviderStartupState = "connecting" | "ready" | "error";

export function providerCanRestore(state: Record<AgentProvider, ProviderStartupState>, provider: AgentProvider) {
  return state[provider] === "ready";
}

export interface ProviderInitializationServices<TModels> {
  loadCodexModels(): Promise<TModels>;
  loadCapabilities(provider: AgentProvider): Promise<AgentCapabilities>;
  isActive(): boolean;
  applyCodexModels(value: TModels): void;
  applyCapabilities(provider: AgentProvider, capabilities: AgentCapabilities): void;
  reportError(provider: AgentProvider, phase: "models" | "capabilities", error: unknown): void;
  setProviderState(provider: AgentProvider, state: Exclude<ProviderStartupState, "connecting">): void;
}

export async function initializeProviders<TModels>(services: ProviderInitializationServices<TModels>) {
  const modelsTask = services.loadCodexModels().then((value) => {
    if (services.isActive()) services.applyCodexModels(value);
    return true;
  }, (error) => {
    if (services.isActive()) services.reportError("codex", "models", error);
    return false;
  });
  const codexCapabilitiesTask = services.loadCapabilities("codex").then((capabilities) => {
    if (services.isActive()) services.applyCapabilities("codex", capabilities);
    return true;
  }, (error) => {
    if (services.isActive()) services.reportError("codex", "capabilities", error);
    return false;
  });
  const claudeCapabilitiesTask = services.loadCapabilities("claude").then((capabilities) => {
    if (services.isActive()) {
      services.applyCapabilities("claude", capabilities);
      services.setProviderState("claude", "ready");
    }
  }, (error) => {
    if (services.isActive()) {
      services.reportError("claude", "capabilities", error);
      services.setProviderState("claude", "error");
    }
  });

  const [modelsReady, codexCapabilitiesReady] = await Promise.all([modelsTask, codexCapabilitiesTask]);
  if (services.isActive()) services.setProviderState("codex", modelsReady && codexCapabilitiesReady ? "ready" : "error");
  await claudeCapabilitiesTask;
}
