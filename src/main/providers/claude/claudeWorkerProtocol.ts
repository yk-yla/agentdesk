import type { JsonObject } from "../../../shared/protocol";

export type ClaudeGatewayFixtureKind = "unauthorized" | "rateLimited" | "serverError" | "truncatedSse" | "timeout" | "offline";
export type ClaudeLifecycleFixtureKind = "longBash" | "hook" | "mcp" | "userQuestion" | "stream" | "compact" | "incompleteTool";
export type ClaudePluginOperation = "list" | "details" | "install" | "uninstall" | "update" | "marketplaceList" | "marketplaceAdd" | "marketplaceUpdate" | "marketplaceRemove";

export type ClaudeWorkerCommand = ({ requestId?: string } & (
  | { type: "start"; sessionId: string; nativeSessionId: string; resumeSessionId?: string; forkSession?: boolean; queryGeneration: number; cwd: string; prompt: string; input?: JsonObject[]; model?: string; effort?: string; executablePath?: string; env?: Record<string, string>; settingSources: string[]; gatewayFixture?: { kind: ClaudeGatewayFixtureKind; timeoutMs?: number; lifecycle?: ClaudeLifecycleFixtureKind } }
  | { type: "compactSession"; sessionId: string; nativeSessionId: string; queryGeneration: number; cwd: string; model?: string; effort?: string; executablePath?: string; env?: Record<string, string>; settingSources: string[]; gatewayFixture?: { kind: ClaudeGatewayFixtureKind; timeoutMs?: number; lifecycle?: ClaudeLifecycleFixtureKind } }
  | { type: "send"; sessionId: string; queryGeneration: number; text: string; input?: JsonObject[] }
  | { type: "interrupt"; sessionId: string; queryGeneration: number }
  | { type: "interactionResponse"; sessionId: string; queryGeneration: number; interactionId: string; result: JsonObject }
  | { type: "control"; sessionId: string; queryGeneration: number; action: "models" | "commands" | "agents" | "contextUsage" | "mcp" | "reloadSkills" | "reloadPlugins" | "setModel" | "setEffort"; value?: string }
  | { type: "plugin"; operation: ClaudePluginOperation; cwd: string; executablePath?: string; env?: Record<string, string>; configDir?: string; plugin?: string; marketplace?: string; source?: string; authorizedLocalMarketplacePath?: string; sparsePaths?: string[] }
  | { type: "closeSession"; sessionId: string; queryGeneration?: number }
  | { type: "listSessions"; cwd?: string; limit: number; offset: number; includeWorktrees: false }
  | { type: "searchSessions"; cwd?: string; searchTerm: string; limit: number; offset: number; includeWorktrees: false }
  | { type: "getSessionInfo"; cwd: string; nativeSessionId: string }
  | { type: "readSession"; cwd: string; nativeSessionId: string; limit?: number; offset?: number }
  | { type: "forkSession"; cwd: string; nativeSessionId: string; title?: string }
  | { type: "renameSession"; cwd: string; nativeSessionId: string; title: string }
  | { type: "deleteSession"; cwd: string; nativeSessionId: string }
  | { type: "testHoldRequests" }
  | { type: "testFatal"; message: string }
  | { type: "close" }
));

export type ClaudeWorkerEvent =
  | { type: "message"; sessionId: string; queryGeneration: number; payload: unknown }
  | { type: "ready"; sessionId: string; queryGeneration: number; nativeSessionId?: string }
  | { type: "processStarted"; sessionId: string; queryGeneration: number; rootPid: number }
  | { type: "interrupted"; sessionId: string; queryGeneration: number }
  | { type: "closed"; sessionId: string; queryGeneration: number }
  | { type: "interactionPending"; sessionId: string; queryGeneration: number; interactionId: string; kind: "permission" | "userQuestion" | "mcpElicitation"; payload: JsonObject }
  | { type: "interactionFinished"; sessionId: string; queryGeneration: number; interactionId: string; status: "resolved" | "cancelled" }
  | { type: "cleanupComplete"; error?: string }
  | { type: "response"; requestId: string; result?: unknown; error?: string }
  | { type: "error"; sessionId?: string; queryGeneration?: number; message: string; payload?: JsonObject }
  | { type: "fatal"; message: string };
