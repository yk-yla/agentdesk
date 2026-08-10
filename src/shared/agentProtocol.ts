import type { JsonObject } from "./protocol";

export type AgentProvider = "codex" | "claude";
export type CapabilityState = "supported" | "temporarilyUnavailable" | "unsupported";

export type AgentCapability =
  | "models"
  | "effort"
  | "images"
  | "history"
  | "historySearch"
  | "rename"
  | "pin"
  | "favorite"
  | "fork"
  | "delete"
  | "interrupt"
  | "steer"
  | "compact"
  | "review"
  | "skills"
  | "commands"
  | "mcp"
  | "pluginsLoad"
  | "pluginMarketplace"
  | "goals"
  | "plans"
  | "subagents"
  | "contextUsage";

export type AgentCapabilities = Record<AgentCapability, CapabilityState>;

export interface NativeSessionRef {
  provider: AgentProvider;
  canonicalCwd: string;
  nativeSessionId: string;
}

export interface ActiveSessionRef extends NativeSessionRef {
  queryGeneration: number;
}

export interface SessionScope {
  canonicalCwd: string;
  cursor?: string | null;
  limit?: number;
  searchTerm?: string;
  includeWorktrees?: boolean;
}

export type PendingInteractionKind = "permission" | "userQuestion" | "mcpElicitation";
export type PendingInteractionStatus = "pending" | "resolving" | "resolved" | "rejected" | "cancelled" | "expired" | "failed";

export interface PendingInteraction {
  provider: AgentProvider;
  sessionId: string;
  queryGeneration: number;
  interactionId: string;
  requestId?: number | string;
  toolUseId?: string;
  kind: PendingInteractionKind;
  status: PendingInteractionStatus;
  expiresAt: number;
  suggestions?: unknown[];
}

export interface InteractionRef {
  provider: AgentProvider;
  sessionId: string;
  queryGeneration: number;
  interactionId: string;
  requestId?: number | string;
  toolUseId?: string;
}

export interface AgentEventEnvelope {
  provider: AgentProvider;
  sessionId?: string;
  queryGeneration?: number;
  requestId?: number | string;
  receivedAt: number;
  type: string;
  payload: unknown;
}

export type AgentOperation =
  | "listModels"
  | "listSkills"
  | "listSessions"
  | "searchSessions"
  | "readSession"
  | "startSession"
  | "resumeSession"
  | "forkSession"
  | "renameSession"
  | "deleteSession"
  | "updateSessionMetadata"
  | "updateSessionSettings"
  | "startTurn"
  | "startReview"
  | "steerTurn"
  | "interruptTurn"
  | "compactSession"
  | "readRateLimits"
  | "listMcpServers"
  | "getGoal"
  | "setGoal"
  | "clearGoal"
  | "listPlugins"
  | "readPlugin"
  | "installPlugin"
  | "uninstallPlugin"
  | "updatePlugin"
  | "addMarketplace"
  | "updateMarketplace"
  | "removeMarketplace"
  | "getCapabilities"
  | "closeSession";

export interface AgentRequestContext {
  requestId?: string;
  sessionId?: string;
  canonicalCwd?: string;
  nativeSessionId?: string;
  queryGeneration?: number;
}

export interface AgentRequest {
  provider: AgentProvider;
  operation: AgentOperation;
  params?: JsonObject;
  context?: AgentRequestContext;
}

export interface AgentInteractionResponse {
  ref: InteractionRef;
  result: JsonObject;
}
