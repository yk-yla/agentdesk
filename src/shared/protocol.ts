import type { AgentEventEnvelope, AgentInteractionResponse, AgentOperation, AgentProvider, AgentRequestContext } from "./agentProtocol";

export type JsonObject = Record<string, unknown>;

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  details: JsonObject;
  processId?: number;
}

export interface ClientLogEntry {
  level?: LogLevel;
  event: string;
  details?: JsonObject;
}

export interface CodexRpcErrorPayload {
  method: string;
  code?: number;
  message: string;
  data?: unknown;
}

export const CODEX_RPC_ERROR_PREFIX = "__CODEX_RPC_ERROR__";

export function encodeCodexRpcError(payload: CodexRpcErrorPayload) {
  return `${CODEX_RPC_ERROR_PREFIX}${JSON.stringify(payload)}`;
}

export function decodeCodexRpcError(value: unknown): CodexRpcErrorPayload | null {
  const message = value instanceof Error ? value.message : String(value);
  const marker = message.indexOf(CODEX_RPC_ERROR_PREFIX);
  if (marker < 0) return null;
  try {
    const payload = JSON.parse(message.slice(marker + CODEX_RPC_ERROR_PREFIX.length)) as CodexRpcErrorPayload;
    return payload && typeof payload.message === "string" && typeof payload.method === "string" ? payload : null;
  } catch {
    return null;
  }
}

export type DisplayMode = "simple" | "full";

export const MIN_BASE_FONT_SIZE = 11;
export const DEFAULT_BASE_FONT_SIZE = 12;
export const MAX_BASE_FONT_SIZE = 14;

export interface BossKeyStatus {
  accelerator: string;
  registered: boolean;
  message: string;
}

export interface ModelContextWindowCacheEntry {
  tokens: number;
  updatedAt: number;
}

export interface ClaudeModelCacheModel {
  id: string;
  resolvedId?: string;
  displayName: string;
  description: string;
  efforts: string[];
  defaultEffort: string;
  supportsImage: boolean;
}

export interface ClaudeModelCache {
  schema: 2;
  claudeVersion: string;
  updatedAt: number;
  models: ClaudeModelCacheModel[];
}

export interface FavoriteSessionSummary {
  provider: AgentProvider;
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
}

export type ThemeId =
  | "github-light"
  | "modern-dark"
  | "github-dark-dimmed"

export interface DesktopPreferences {
  recentWorkspaces: string[];
  lastWorkspace: string;
  favoriteWorkspaces: string[];
  sidebarWidth?: number;
  baseFontSize?: number;
  sessionAliases?: Record<string, string>;
  favoriteSessions?: string[];
  favoriteSessionSummaries?: Record<string, FavoriteSessionSummary>;
  theme: ThemeId;
  displayMode: DisplayMode;
  bossKey: string;
  modelContextWindows?: Record<string, ModelContextWindowCacheEntry>;
  claudeModelCache?: ClaudeModelCache;
  lastReasoningEfforts?: Partial<Record<AgentProvider, string>>;
  trustedClaudeWorkspaces?: string[];
  workspaceState?: JsonObject;
}

export interface CodexDefaults {
  model: string;
  effort: string;
}

export interface SavedImage {
  path: string;
  dataUrl: string;
  name: string;
}

export interface SavedTextFile {
  path: string;
}

export interface HandoffPackage {
  path: string;
  prompt: string;
}

export interface DesktopNotification {
  sessionId: string;
  provider: AgentProvider;
  sessionTitle: string;
}

export interface DesktopWindowState {
  maximized: boolean;
}

export type DesktopUpdatePhase =
  | "idle"
  | "authorizationRequired"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "downloaded"
  | "error"
  | "unsupported";

export interface DesktopUpdateStatus {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  message: string;
  tokenConfigured: boolean;
  repositoryUrl: string;
}

export type CodexCliUpdatePhase =
  | "idle"
  | "checking"
  | "updating"
  | "upToDate"
  | "available"
  | "notInstalled"
  | "error";

export interface CodexCliUpdateStatus {
  phase: CodexCliUpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  checkedAt?: number;
  nextCheckAt?: number;
  message: string;
}

export type ClaudeCodeUpdatePhase = "idle" | "checking" | "upToDate" | "available" | "updating" | "updated" | "notInstalled" | "error";

export interface ClaudeRuntimeStatus {
  phase: ClaudeCodeUpdatePhase;
  binarySource: "managed" | "sdk";
  binaryVersion: string;
  sdkVersion: string;
  latestVersion?: string;
  checkedAt?: number;
  credentialsAvailable: boolean;
  credentialSource: "settings" | "process" | "unavailable";
  credentialMessage: string;
  trustedWorkspaces: string[];
  integrityVerified?: boolean;
  integritySigner?: string;
  integrityStatus?: string;
  message: string;
}

export interface CodexRequestContext {
  sessionId?: string;
}

export interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: {
    code?: number;
    message: string;
    data?: unknown;
  };
}

export interface CodexBridge {
  request(method: string, params?: JsonObject, context?: CodexRequestContext): Promise<unknown>;
  respond(id: number | string, result: JsonObject): Promise<void>;
  getWorkspace(): Promise<string>;
  getLaunchProvider(): Promise<AgentProvider | null>;
  chooseWorkspace(defaultPath?: string): Promise<string | null>;
  getPreferences(): Promise<DesktopPreferences>;
  getCodexDefaults(): Promise<CodexDefaults>;
  savePreferences(preferences: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
  writeLog(entry: ClientLogEntry): Promise<void>;
  getBossKeyStatus(): Promise<BossKeyStatus>;
  setBossKey(accelerator: string): Promise<BossKeyStatus>;
  saveClipboardImage(dataUrl: string, suggestedName?: string): Promise<SavedImage>;
  saveTextFile(content: string, suggestedName?: string): Promise<SavedTextFile | null>;
  createHandoffPackage(input: { cwd: string; title: string; threadId: string; content: string }): Promise<HandoffPackage>;
  openWindowsTerminal(cwd: string): Promise<void>;
  readLocalImage(filePath: string): Promise<string | null>;
  openLocalPath(filePath: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  showNotification(notification: DesktopNotification): Promise<boolean>;
  getWindowState(): Promise<DesktopWindowState>;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<DesktopWindowState>;
  getUpdateStatus(): Promise<DesktopUpdateStatus>;
  saveUpdateToken(token: string): Promise<DesktopUpdateStatus>;
  clearUpdateToken(): Promise<DesktopUpdateStatus>;
  checkForUpdates(): Promise<DesktopUpdateStatus>;
  downloadUpdate(): Promise<DesktopUpdateStatus>;
  installUpdate(): Promise<void>;
  onWindowState(listener: (state: DesktopWindowState) => void): () => void;
  onUpdateStatus(listener: (status: DesktopUpdateStatus) => void): () => void;
  getCodexCliUpdateStatus(): Promise<CodexCliUpdateStatus>;
  checkCodexCliUpdates(): Promise<CodexCliUpdateStatus>;
  updateCodexCli(): Promise<CodexCliUpdateStatus>;
  onCodexCliUpdateStatus(listener: (status: CodexCliUpdateStatus) => void): () => void;
  getClaudeRuntimeStatus(): Promise<ClaudeRuntimeStatus>;
  checkClaudeCodeUpdates(): Promise<ClaudeRuntimeStatus>;
  updateClaudeCode(allowUnverified: boolean): Promise<ClaudeRuntimeStatus>;
  revokeClaudeWorkspace(cwd: string): Promise<ClaudeRuntimeStatus>;
  onClaudeRuntimeStatus(listener: (status: ClaudeRuntimeStatus) => void): () => void;
  onMessage(listener: (message: JsonRpcMessage) => void): () => void;
}

/** Provider 无关的正式 Bridge。桌面能力继续复用原有受控 IPC。 */
export interface AgentBridge extends Omit<CodexBridge, "request" | "respond" | "onMessage"> {
  agentRequest(provider: AgentProvider, operation: AgentOperation, params?: JsonObject, context?: AgentRequestContext): Promise<unknown>;
  respondToInteraction(response: AgentInteractionResponse): Promise<void>;
  onAgentEvent(listener: (event: AgentEventEnvelope) => void): () => void;
  dev?: {
    holdClaudeWorkerRequests(): Promise<void>;
    injectClaudeWorkerFatal(): Promise<void>;
    setClaudeLifecycleFixture(kind: "longBash" | "hook" | "mcp" | "approval" | "stream" | "compact" | "incompleteTool" | null): Promise<{ kind: string | null }>;
    setDesktopUpdateFixture(): Promise<DesktopUpdateStatus>;
    shutdownDryRun(): Promise<{ ok: true }>;
    quitForTesting(): Promise<{ requested: true }>;
    setClaudeGatewayFixture(kind: "unauthorized" | "rateLimited" | "serverError" | "truncatedSse" | "timeout" | "offline" | null): Promise<{ kind: string | null; baseUrl?: string }>;
    setClaudeSignatureFixture(kind: "official" | "otherSigned" | "unsigned"): Promise<ClaudeRuntimeStatus>;
  };
}
