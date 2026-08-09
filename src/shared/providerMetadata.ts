import type { AgentProvider } from "./agentProtocol";

export function providerDisplayName(provider: AgentProvider) {
  return provider === "claude" ? "Claude Code" : "Codex";
}

export function providerNotificationTitle(provider: AgentProvider) {
  return `${providerDisplayName(provider)} 已完成`;
}
