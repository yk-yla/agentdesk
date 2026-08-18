import type { AgentCapabilities, AgentOperation, AgentProvider } from "../../shared/agentProtocol";
import { providerDisplayName } from "../../shared/providerMetadata";
import type { ClaudeModelCache, CodexDefaults, JsonObject } from "../../shared/protocol";
import {
  CODEX_CAPABILITIES,
  defaultEffortFor,
  defaultModelFor,
  EMPTY_AGENT_CAPABILITIES,
  emptySession,
  findModelOption,
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
  historyParams(input: { cursor: string | null; limit: number; cwd?: string; allWorkspaces?: boolean }): JsonObject;
}

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
    historyParams: ({ cursor, limit, cwd, allWorkspaces }) => ({ cursor, limit, sortKey: "recency_at", sortDirection: "desc", sourceKinds: ["cli", "vscode", "exec", "appServer"], archived: false, ...(allWorkspaces ? { allWorkspaces: true } : cwd ? { cwd } : {}) }),
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
    historyParams: ({ cursor, limit, cwd, allWorkspaces }) => ({ cursor, limit, ...(allWorkspaces ? { allWorkspaces: true } : cwd ? { cwd } : {}) }),
  },
};

export function initialProviderCapabilities() {
  return Object.fromEntries((Object.keys(definitions) as AgentProvider[]).map((provider) => [provider, { ...definitions[provider].initialCapabilities }])) as Record<AgentProvider, AgentCapabilities>;
}

export function initialProviderModels(cache?: ClaudeModelCache, claudeVersion?: string): Record<AgentProvider, ModelOption[]> {
  const cached = usableClaudeCachedModels(cache, claudeVersion);
  return { codex: [], claude: cached.length ? cached : CLAUDE_BOOTSTRAP_MODELS };
}

export function newSessionDefaults(provider: AgentProvider, models: ModelOption[], defaults: CodexDefaults, capabilities: AgentCapabilities, preferredEffort = "") {
  const values = definitions[provider].sessionDefaults(models, defaults);
  const model = findModelOption(models, values.model);
  const effort = model?.efforts.includes(preferredEffort) ? preferredEffort : values.effort;
  return { ...values, effort, capabilities: { ...(definitions[provider].affectsStartupState ? capabilities : definitions[provider].initialCapabilities) } };
}

export function retargetEmptySession(
  session: SessionState,
  provider: AgentProvider,
  cwd: string,
  threadId: string,
  title: string,
  models: ModelOption[],
  defaults: CodexDefaults,
  capabilities: AgentCapabilities,
) {
  const target = newSessionDefaults(provider, models, defaults, capabilities);
  const next = emptySession(session.id, cwd, target.model, target.effort, provider);
  next.capabilities = target.capabilities;
  next.threadId = threadId;
  next.title = title;
  next.titleOrigin = "provider";
  return next;
}

export function applyProviderModelDefaults(session: SessionState, models: ModelOption[], defaults: CodexDefaults, preferredEffort = "") {
  const values = newSessionDefaults(session.provider, models, defaults, session.capabilities, preferredEffort);
  if (!values.model || session.model) return session;
  return { ...session, model: values.model, effort: values.effort };
}

export function normalizeAgentRequestError(provider: AgentProvider, operation: AgentOperation, error: unknown) {
  return definitions[provider].normalizeRequestError(error, operation);
}

export function providerHistoryParams(provider: AgentProvider, input: { cursor: string | null; limit: number; cwd?: string; allWorkspaces?: boolean }) {
  return definitions[provider].historyParams(input);
}

export function providerAffectsStartupState(provider: AgentProvider) {
  return definitions[provider].affectsStartupState;
}

export function providerDisconnectedMessage(provider: AgentProvider) {
  return `${providerDisplayName(provider)} 服务已断开，会话创建结果已作废。`;
}

