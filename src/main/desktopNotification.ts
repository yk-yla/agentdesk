import type { AgentProvider } from "../shared/agentProtocol";
import { providerNotificationTitle } from "../shared/providerMetadata";

export interface NormalizedDesktopNotification {
  sessionId: string;
  provider: AgentProvider;
  title: string;
  body?: string;
}

export function normalizeDesktopNotification(input: unknown): NormalizedDesktopNotification | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim().slice(0, 160) : "";
  const provider = value.provider === "codex" || value.provider === "claude" ? value.provider : null;
  if (!sessionId || !provider) return null;
  const body = typeof value.sessionTitle === "string" ? value.sessionTitle.trim().slice(0, 120) : "";
  return { sessionId, provider, title: providerNotificationTitle(provider), ...(body ? { body } : {}) };
}

