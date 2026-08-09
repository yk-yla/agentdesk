import type { AgentEventEnvelope, AgentOperation, AgentProvider } from "../../shared/agentProtocol";
import type { JsonObject } from "../../shared/protocol";
import type { ModelOption, SessionState } from "../domain";
import {
  adaptCodexEvent,
  applyServerMessage as applyCodexEvent,
  applySubagentMessage as applyCodexSubagentEvent,
  goalFromValue as codexGoalFromValue,
  hydrateSession as hydrateCodexSession,
  normalizeModel as normalizeCodexModel,
  type RoutedCodexEvent,
} from "../providers/codex/codexEventAdapter";
import {
  adaptClaudeEvent,
  applyClaudeEvent,
  hydrateClaudeSession,
  normalizeClaudeModel,
  type RoutedClaudeEvent,
} from "../providers/claude/claudeEventAdapter";

export type AgentEventKind =
  | "ready"
  | "sessionDeleted"
  | "backendExited"
  | "closeActiveTab"
  | "skillsChanged"
  | "activateSession"
  | "lateResponse"
  | "openWorkspace"
  | "sessionStarted"
  | "sessionSettingsUpdated"
  | "turnCompleted"
  | "state";

export interface RoutedAgentEvent {
  provider: AgentProvider;
  kind: AgentEventKind;
  envelope: AgentEventEnvelope;
  nativeSessionId?: string;
  parentNativeSessionId?: string;
  childNativeSessionId?: string;
  clientSessionId?: string;
  workspace?: string;
  turnStatus?: string;
  committedClientId?: string;
  settings?: { model?: string; effort?: string };
  lateResponse?: { operation?: AgentOperation; result?: unknown; error?: unknown };
  batched: boolean;
  lifecycle: boolean;
  providerEvent: RoutedCodexEvent | RoutedClaudeEvent;
}

interface RendererProviderAdapter {
  route(event: AgentEventEnvelope): RoutedAgentEvent;
  apply(session: SessionState, event: RoutedAgentEvent): ReturnType<typeof applyCodexEvent>;
  applySubagent(session: SessionState, event: RoutedAgentEvent, nativeSessionId: string): SessionState;
  hydrate(session: SessionState, value: unknown, options?: { preserveRealtime?: boolean; preserveLifecycle?: boolean }): SessionState;
  normalizeModel(value: unknown): ModelOption;
  goal(value: unknown): ReturnType<typeof codexGoalFromValue>;
}

const adapters: Record<AgentProvider, RendererProviderAdapter | undefined> = {
  codex: {
    route: (event) => adaptCodexEvent(event) as RoutedAgentEvent,
    apply: (session, event) => applyCodexEvent(session, (event.providerEvent as RoutedCodexEvent).message),
    applySubagent: (session, event, nativeSessionId) => applyCodexSubagentEvent(session, (event.providerEvent as RoutedCodexEvent).message, nativeSessionId),
    hydrate: hydrateCodexSession,
    normalizeModel: normalizeCodexModel,
    goal: codexGoalFromValue,
  },
  claude: {
    route: (event) => adaptClaudeEvent(event) as RoutedAgentEvent,
    apply: (session, event) => applyClaudeEvent(session, event.providerEvent as RoutedClaudeEvent),
    applySubagent: (session) => session,
    hydrate: hydrateClaudeSession,
    normalizeModel: normalizeClaudeModel,
    goal: () => null,
  },
};

function adapter(provider: AgentProvider) {
  const value = adapters[provider];
  if (!value) throw new Error("Provider 适配器暂不可用：" + provider);
  return value;
}

export function routeAgentEvent(event: AgentEventEnvelope) {
  return adapter(event.provider).route(event);
}

export function applyAgentEvent(session: SessionState, event: RoutedAgentEvent) {
  return adapter(event.provider).apply(session, event);
}

export function applyAgentSubagentEvent(session: SessionState, event: RoutedAgentEvent, nativeSessionId: string) {
  return adapter(event.provider).applySubagent(session, event, nativeSessionId);
}

export function hydrateAgentSession(session: SessionState, provider: AgentProvider, value: unknown, options: { preserveRealtime?: boolean; preserveLifecycle?: boolean } = {}) {
  return adapter(provider).hydrate(session, value, options);
}

export function normalizeAgentModel(provider: AgentProvider, value: unknown) {
  return adapter(provider).normalizeModel(value);
}

export function goalFromAgentValue(provider: AgentProvider, value: unknown) {
  return adapter(provider).goal(value);
}

export function agentEventPayload(event: RoutedAgentEvent): JsonObject {
  const payload = event.envelope.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as JsonObject : {};
}
