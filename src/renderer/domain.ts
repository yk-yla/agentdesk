import type { CodexDefaults, DisplayMode, JsonObject, ThemeId } from "../shared/protocol";
import type { AgentCapabilities, AgentProvider } from "../shared/agentProtocol";

export type Role = "user" | "assistant" | "system";
export type ActivityKind = "commandExecution" | "fileChange" | "mcpToolCall" | "plan" | "reasoning" | "subAgent" | "other";
export type ActivityStatus = "inProgress" | "completed" | "failed" | "declined" | "interrupted";
export type CollaborationMode = "default" | "plan";
export type PlanStepStatus = "pending" | "inProgress" | "completed";

export interface ImageAttachment {
  path: string;
  dataUrl: string;
  name: string;
}

export interface SkillOption {
  name: string;
  description: string;
  path: string;
  scope: string;
  enabled: boolean;
}

export interface QueuedMessage {
  id: string;
  text: string;
  inputText?: string;
  images: ImageAttachment[];
  skills?: Array<Pick<SkillOption, "name" | "path">>;
  clientUserMessageId?: string;
  queueKind?: "explicit" | "rejectedSteer";
  sequence?: number;
}

export interface PendingSteerMessage extends QueuedMessage {
  clientUserMessageId: string;
  expectedTurnId: string;
}

export interface Message {
  id: string;
  clientId?: string;
  role: Role;
  text: string;
  images: ImageAttachment[];
  timestamp?: number;
  streaming?: boolean;
}

export interface Activity {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  status: ActivityStatus;
  output?: string;
  visibleInMain: boolean;
}

export interface PendingApproval {
  requestId: number | string;
  method: string;
  threadId: string;
  title: string;
  detail: string;
  kind: "commandApproval" | "fileApproval" | "permissionsApproval" | "userInput" | "elicitation";
  reason?: string;
  cwd?: string;
  command?: string;
  availableDecisions?: string[];
  availableDecisionPayloads?: unknown[];
  proposedExecpolicyAmendment?: unknown;
  proposedNetworkPolicyAmendments?: unknown[];
  grantRoot?: string;
  networkApprovalContext?: JsonObject;
  permissions?: JsonObject;
  questions?: UserInputQuestion[];
  elicitationMode?: "form" | "url";
  elicitationMessage?: string;
  elicitationUrl?: string;
  elicitationId?: string;
  serverName?: string;
  requestedSchema?: JsonObject;
  interactionId?: string;
  queryGeneration?: number;
  toolUseId?: string;
  suggestions?: unknown[];
}

export type GoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export interface SessionGoal {
  threadId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionPlan {
  explanation: string;
  steps: Array<{ step: string; status: PlanStepStatus }>;
  updatedAt: number;
}

export type SubagentStatus = "pendingInit" | "running" | "interrupted" | "completed" | "errored" | "shutdown" | "notFound";

export interface SubagentState {
  threadId: string;
  nickname: string;
  role: string;
  prompt: string;
  model: string;
  effort: string;
  status: SubagentStatus;
  message: string;
  updatedAt: number;
}

export interface UserInputOption {
  label: string;
  description?: string;
}

export interface UserInputQuestion {
  id: string;
  header?: string;
  question: string;
  options?: UserInputOption[];
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
}

export interface TokenUsage {
  used: number;
  total: number | null;
}

export interface ModelOption {
  id: string;
  resolvedId?: string;
  displayName: string;
  description: string;
  efforts: string[];
  defaultEffort: string;
  supportsImage: boolean;
}

export function findModelOption(models: ModelOption[], id: string) {
  return models.find((model) => model.id === id) || models.find((model) => model.resolvedId === id);
}

export interface RetryState {
  turnId: string;
  attempt: number;
  message: string;
  additionalDetails: string;
  previousStatusLabel: string;
}

export interface SessionState {
  id: string;
  provider: AgentProvider;
  queryGeneration: number;
  capabilities: AgentCapabilities;
  threadId: string | null;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  activities: Activity[];
  model: string;
  resolvedModel?: string;
  effort: string;
  collaborationMode: CollaborationMode;
  resumed?: boolean;
  /** Provider reports that another client currently owns this thread's writer. */
  readOnly?: boolean;
  status: "idle" | "working" | "error";
  statusLabel: string;
  activeTurnId: string | null;
  startedAt: number | null;
  errorText: string;
  retryState: RetryState | null;
  pendingApprovals: PendingApproval[];
  goal: SessionGoal | null;
  plan: SessionPlan | null;
  subagents: SubagentState[];
  tokenUsage: TokenUsage;
  compactionCount: number;
  compactionEventIds: string[];
  detailsOpen: boolean;
  detailView: "activity" | "raw" | "goal" | "plan" | "agents";
}

/** 侧栏历史条目；cwdKey 和 titleLower 是预算字段，只在创建时算一次。 */
export interface HistoryThread {
  id: string;
  provider: AgentProvider;
  title: string;
  cwd: string;
  updatedAt: number;
  source: string;
  isPinned: boolean;
  isFavorite: boolean;
  cwdKey: string;
  titleLower: string;
  parentThreadId?: string;
  agentNickname?: string;
  agentRole?: string;
  searchSnippet?: string;
}

export interface PaneState {
  id: string;
  tabIds: string[];
  activeTabId: string;
}

export interface LayoutState {
  panes: PaneState[];
  activePaneId: string;
}

export const DEFAULT_THEME: ThemeId = "github-light";
export const DEFAULT_DISPLAY_MODE: DisplayMode = "simple";
export const EMPTY_CODEX_DEFAULTS: CodexDefaults = { model: "", effort: "" };

export const CODEX_CAPABILITIES: AgentCapabilities = {
  models: "supported", effort: "supported", images: "supported", history: "supported", historySearch: "supported",
  rename: "supported", pin: "supported", favorite: "supported", fork: "supported", delete: "supported", interrupt: "supported",
  steer: "supported", compact: "supported", review: "supported", skills: "supported", commands: "supported", mcp: "supported",
  pluginsLoad: "supported", pluginMarketplace: "supported", goals: "supported", plans: "supported", subagents: "supported", contextUsage: "supported",
};

export const EMPTY_AGENT_CAPABILITIES: AgentCapabilities = {
  models: "temporarilyUnavailable", effort: "temporarilyUnavailable", images: "temporarilyUnavailable", history: "temporarilyUnavailable", historySearch: "temporarilyUnavailable",
  rename: "temporarilyUnavailable", pin: "temporarilyUnavailable", favorite: "temporarilyUnavailable", fork: "temporarilyUnavailable", delete: "temporarilyUnavailable", interrupt: "temporarilyUnavailable",
  steer: "temporarilyUnavailable", compact: "temporarilyUnavailable", review: "temporarilyUnavailable", skills: "temporarilyUnavailable", commands: "temporarilyUnavailable", mcp: "temporarilyUnavailable",
  pluginsLoad: "temporarilyUnavailable", pluginMarketplace: "temporarilyUnavailable", goals: "temporarilyUnavailable", plans: "temporarilyUnavailable", subagents: "temporarilyUnavailable", contextUsage: "temporarilyUnavailable",
};

export function defaultModelFor(models: ModelOption[], defaults: CodexDefaults) {
  return models.find((model) => model.id === defaults.model) || models[0];
}

export function defaultEffortFor(model: ModelOption | undefined, defaults: CodexDefaults) {
  return model && defaults.effort && model.efforts.includes(defaults.effort) ? defaults.effort : model?.defaultEffort || "medium";
}

export function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" ? (value as JsonObject) : {};
}

export function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function imageFromContent(value: unknown): ImageAttachment | null {
  const content = asRecord(value);
  if (content.type === "localImage" && typeof content.path === "string") {
    return { path: content.path, dataUrl: "", name: content.path.split(/[\\/]/).pop() || "图片" };
  }
  if (content.type === "image" && typeof content.url === "string") {
    return { path: "", dataUrl: content.url, name: "图片" };
  }
  return null;
}

export function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  const content = asRecord(value);
  if (content.type === "text") return stringValue(content.text);
  if (content.type === "skill") {
    const name = stringValue(content.name);
    return name ? `/${name}` : "";
  }
  return "";
}

export function sessionTitle(text: string, fallback = "新会话") {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine ? oneLine.slice(0, 42) : fallback;
}

export function formatCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

export function formatRelativeTime(timestamp: number) {
  if (!timestamp) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`;
  return `${Math.floor(seconds / 86400)}天前`;
}

export function formatElapsed(startedAt: number | null, now: number) {
  if (!startedAt) return "0s";
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours}h ${minutes}m ${seconds}s` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function emptySession(id: string, cwd: string, model = "", effort = "", provider: AgentProvider = "codex") : SessionState {
  const now = Date.now();
  return {
    id, provider, queryGeneration: 0, capabilities: { ...EMPTY_AGENT_CAPABILITIES }, threadId: null, cwd, title: "新会话", createdAt: now, updatedAt: now, messages: [], activities: [],
    model, effort, collaborationMode: "default", status: "idle", statusLabel: "就绪", activeTurnId: null, startedAt: null, errorText: "", retryState: null, pendingApprovals: [], goal: null, plan: null, subagents: [],
    tokenUsage: { used: 0, total: null }, compactionCount: 0, compactionEventIds: [], detailsOpen: false, detailView: "activity",
  };
}

export function basename(value: string) {
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

export function normalizedDirectory(value: string) {
  return value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function sameDirectory(left: string, right: string) {
  return Boolean(left && right) && normalizedDirectory(left) === normalizedDirectory(right);
}

/** 预算好目录键和小写标题，避免侧栏每次渲染都重跑正则和 toLowerCase。 */
export function historyThread(input: { id: string; provider?: AgentProvider; title: string; cwd: string; updatedAt: number; source: string; isPinned?: boolean; isFavorite?: boolean; parentThreadId?: string; agentNickname?: string; agentRole?: string }): HistoryThread {
  return { ...input, provider: input.provider || "codex", isPinned: input.isPinned === true, isFavorite: input.isFavorite === true, cwdKey: normalizedDirectory(input.cwd), titleLower: input.title.toLowerCase() };
}

export function threadFromList(value: unknown): HistoryThread[] {
  const result = asRecord(value);
  const data = Array.isArray(result.data) ? result.data : [];
  return data.map((entry) => {
    const thread = asRecord(entry);
    return historyThread({
      id: stringValue(thread.id),
      title: stringValue(thread.name, stringValue(thread.preview, "无标题会话")),
      cwd: stringValue(thread.cwd),
      updatedAt: numberValue(thread.updatedAt) * 1000,
      source: stringValue(asRecord(thread.source).kind, stringValue(thread.source, "Codex")),
      provider: thread.provider === "claude" ? "claude" : "codex",
      isPinned: thread.isPinned === true,
      parentThreadId: stringValue(thread.parentThreadId) || undefined,
      agentNickname: stringValue(thread.agentNickname) || undefined,
      agentRole: stringValue(thread.agentRole) || undefined,
    });
  }).filter((entry) => entry.id);
}

export function threadFromSearch(value: unknown): HistoryThread[] {
  const result = asRecord(value);
  const data = Array.isArray(result.data) ? result.data : [];
  return data.reduce<HistoryThread[]>((entries, entry) => {
    const searchResult = asRecord(entry);
    const thread = asRecord(searchResult.thread);
    const item = threadFromList({ data: [thread] })[0];
    if (item) entries.push({ ...item, searchSnippet: stringValue(searchResult.snippet) });
    return entries;
  }, []);
}

/** 发送消息后就地更新历史，替代原来的全量重取。 */
export function upsertHistoryEntry(history: HistoryThread[], entry: { id: string; provider?: AgentProvider; title: string; cwd: string }): HistoryThread[] {
  const provider = entry.provider || "codex";
  const existing = history.find((item) => item.provider === provider && item.id === entry.id);
  const next = historyThread({
    id: entry.id,
    provider,
    title: existing && existing.title !== "新会话" ? existing.title : entry.title,
    cwd: entry.cwd || existing?.cwd || "",
    updatedAt: Date.now(),
    source: existing?.source || "appServer",
    isPinned: existing?.isPinned || false,
    isFavorite: existing?.isFavorite || false,
  });
  return [next, ...history.filter((item) => item.provider !== provider || item.id !== entry.id)];
}
