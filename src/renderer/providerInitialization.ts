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

export async function initializeProviders<TModels>(services: ProviderInitializationServices<TModels>, providers: AgentProvider[] = ["codex", "claude"]) {
  const requested = new Set(providers);
  const tasks: Promise<void>[] = [];
  if (requested.has("codex")) {
    tasks.push(Promise.all([
      services.loadCodexModels().then((value) => {
        if (services.isActive()) services.applyCodexModels(value);
        return true;
      }, (error) => {
        if (services.isActive()) services.reportError("codex", "models", error);
        return false;
      }),
      services.loadCapabilities("codex").then((capabilities) => {
        if (services.isActive()) services.applyCapabilities("codex", capabilities);
        return true;
      }, (error) => {
        if (services.isActive()) services.reportError("codex", "capabilities", error);
        return false;
      }),
    ]).then(([modelsReady, capabilitiesReady]) => {
      if (services.isActive()) services.setProviderState("codex", modelsReady && capabilitiesReady ? "ready" : "error");
    }));
  }
  if (requested.has("claude")) {
    tasks.push(services.loadCapabilities("claude").then((capabilities) => {
      if (services.isActive()) {
        services.applyCapabilities("claude", capabilities);
        services.setProviderState("claude", "ready");
      }
    }, (error) => {
      if (services.isActive()) {
        services.reportError("claude", "capabilities", error);
        services.setProviderState("claude", "error");
      }
    }));
  }
  await Promise.all(tasks);
}
