import type { AgentCapabilities, AgentOperation, AgentProvider } from "../../shared/agentProtocol";
import { providerDisplayName } from "../../shared/providerMetadata";
import type { ClaudeModelCache, CodexDefaults, JsonObject } from "../../shared/protocol";
import {
  CODEX_CAPABILITIES,
  defaultEffortFor,
  defaultModelFor,
  EMPTY_AGENT_CAPABILITIES,
  type ModelOption,
  type SessionState,
} from "../domain";
import { normalizeCodexRequestError } from "../inputQueue";
import { usableClaudeCachedModels } from "./claudeModelCache";

interface RendererProviderDefinition {
  initialCapabilities: AgentCapabilities;
  affectsStartupState: boolean;
  sessionDefaults(models: ModelOption[], defaults: CodexDefaults): { model: string; effort: string };
  normalizeRequestError(error: unknown, operation: AgentOperation): Error;
  historyParams(input: { cursor: string | null; limit: number; cwd?: string }): JsonObject;
  trustWorkspace(error: Error, fallbackCwd?: string): string | null;
}

const CLAUDE_TRUST_REQUIRED_PREFIX = "__CLAUDE_WORKSPACE_TRUST_REQUIRED__";
const CLAUDE_BOOTSTRAP_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_BOOTSTRAP_MODELS: ModelOption[] = [
  { id: "default", displayName: "Default (recommended)", description: "使用 Claude Code 当前推荐模型", efforts: CLAUDE_BOOTSTRAP_EFFORTS, defaultEffort: "medium", supportsImage: true },
  { id: "opus[1m]", displayName: "Opus (1M context)", description: "Opus 长上下文模型", efforts: CLAUDE_BOOTSTRAP_EFFORTS, defaultEffort: "medium", supportsImage: true },
  { id: "sonnet", displayName: "Sonnet", description: "Sonnet 模型", efforts: CLAUDE_BOOTSTRAP_EFFORTS, defaultEffort: "medium", supportsImage: true },
  { id: "sonnet[1m]", displayName: "Sonnet (1M context)", description: "Sonnet 长上下文模型", efforts: CLAUDE_BOOTSTRAP_EFFORTS, defaultEffort: "medium", supportsImage: true },
  { id: "haiku", displayName: "Haiku", description: "Haiku 快速模型", efforts: [], defaultEffort: "", supportsImage: true },
];
const CLAUDE_INITIAL_CAPABILITIES: AgentCapabilities = {
  ...EMPTY_AGENT_CAPABILITIES,
  models: "supported",
  effort: "supported",
  images: "supported",
  history: "supported",
  historySearch: "supported",
  rename: "supported",
  pin: "unsupported",
  favorite: "supported",
  fork: "supported",
  delete: "supported",
  interrupt: "supported",
  steer: "unsupported",
  review: "unsupported",
  pluginMarketplace: "supported",
  goals: "unsupported",
  plans: "unsupported",
};

const definitions: Record<AgentProvider, RendererProviderDefinition> = {
  codex: {
    initialCapabilities: CODEX_CAPABILITIES,
    affectsStartupState: true,
    sessionDefaults(models, defaults) {
      const model = defaultModelFor(models, defaults);
      return { model: model?.id || "", effort: defaultEffortFor(model, defaults) };
    },
    normalizeRequestError: normalizeCodexRequestError,
    historyParams: ({ cursor, limit, cwd }) => ({ cursor, limit, sortKey: "recency_at", sortDirection: "desc", sourceKinds: ["cli", "vscode", "exec", "appServer"], archived: false, ...(cwd ? { cwd } : {}) }),
    trustWorkspace: () => null,
  },
  claude: {
    initialCapabilities: CLAUDE_INITIAL_CAPABILITIES,
    affectsStartupState: false,
    sessionDefaults(models) {
      const model = models[0];
      return { model: model?.id || "", effort: model?.defaultEffort || "" };
    },
    normalizeRequestError(error) {
      return error instanceof Error ? error : new Error("Claude Code 请求失败。" );
    },
    historyParams: ({ cursor, limit, cwd }) => ({ cursor, limit, ...(cwd ? { cwd } : {}) }),
    trustWorkspace(error, fallbackCwd) {
      const marker = error.message.indexOf(CLAUDE_TRUST_REQUIRED_PREFIX);
      return marker < 0 ? null : error.message.slice(marker + CLAUDE_TRUST_REQUIRED_PREFIX.length).trim() || fallbackCwd || "当前目录";
    },
  },
};

export function initialProviderCapabilities() {
  return Object.fromEntries((Object.keys(definitions) as AgentProvider[]).map((provider) => [provider, { ...definitions[provider].initialCapabilities }])) as Record<AgentProvider, AgentCapabilities>;
}

export function initialProviderModels(cache?: ClaudeModelCache, claudeVersion?: string): Record<AgentProvider, ModelOption[]> {
  const cached = usableClaudeCachedModels(cache, claudeVersion);
  return { codex: [], claude: cached.length ? cached : CLAUDE_BOOTSTRAP_MODELS };
}

export function newSessionDefaults(provider: AgentProvider, models: ModelOption[], defaults: CodexDefaults, capabilities: AgentCapabilities) {
  return { ...definitions[provider].sessionDefaults(models, defaults), capabilities: { ...(definitions[provider].affectsStartupState ? capabilities : definitions[provider].initialCapabilities) } };
}

export function applyProviderModelDefaults(session: SessionState, models: ModelOption[], defaults: CodexDefaults) {
  const values = definitions[session.provider].sessionDefaults(models, defaults);
  if (!values.model || session.model) return session;
  return { ...session, model: values.model, effort: values.effort };
}

export function normalizeAgentRequestError(provider: AgentProvider, operation: AgentOperation, error: unknown) {
  return definitions[provider].normalizeRequestError(error, operation);
}

export function trustWorkspaceForRequest(provider: AgentProvider, operation: AgentOperation, error: Error, fallbackCwd?: string) {
  if (operation !== "startSession" && operation !== "resumeSession") return null;
  return definitions[provider].trustWorkspace(error, fallbackCwd);
}

export function providerHistoryParams(provider: AgentProvider, input: { cursor: string | null; limit: number; cwd?: string }) {
  return definitions[provider].historyParams(input);
}

export function providerAffectsStartupState(provider: AgentProvider) {
  return definitions[provider].affectsStartupState;
}

export function providerDisconnectedMessage(provider: AgentProvider) {
  return `${providerDisplayName(provider)} 服务已断开，会话创建结果已作废。`;
}

export function workspaceForProvider(session: SessionState | undefined, provider: AgentProvider) {
  return session?.provider === provider ? session.cwd : "";
}

