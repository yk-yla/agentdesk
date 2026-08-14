import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentBackend } from "../../agent/AgentBackend";
import type { AgentCapabilities, AgentEventEnvelope, AgentOperation, AgentRequestContext, InteractionRef, PendingInteractionKind, PendingInteractionStatus } from "../../../shared/agentProtocol";
import type { JsonObject } from "../../../shared/protocol";
import { credentialEnv, readClaudeCredentials } from "./claudeCredentials";
import { canonicalWorkspace, isWithinDirectory } from "../../localPathPolicy";
import type { ClaudeGatewayFixtureKind, ClaudeLifecycleFixtureKind, ClaudePluginOperation, ClaudeWorkerEvent } from "./claudeWorkerProtocol";
import { resolveExecutableFromPath } from "../../executablePath";


const CAPABILITIES: AgentCapabilities = {
  models: "supported", effort: "supported", images: "supported", history: "supported",
  historySearch: "supported", rename: "supported", pin: "unsupported", favorite: "supported", fork: "supported",
  delete: "supported", interrupt: "supported", steer: "unsupported", compact: "temporarilyUnavailable", review: "unsupported",
  skills: "temporarilyUnavailable", commands: "temporarilyUnavailable", mcp: "temporarilyUnavailable", pluginsLoad: "temporarilyUnavailable",
  pluginMarketplace: "supported", goals: "unsupported", plans: "unsupported", subagents: "temporarilyUnavailable", contextUsage: "temporarilyUnavailable",
};

interface ClaudeSession {
  clientSessionId: string;
  nativeSessionId: string;
  cwd: string;
  queryGeneration: number;
  queryActive: boolean;
  turnId: string | null;
  model: string;
  effort: string;
  resumeNativeSessionId?: string;
  mode: "new" | "resume";
  pendingStart?: { queryGeneration: number; resumeNativeSessionId?: string; mode: "new" | "resume" };
  toolCalls: Map<string, { name: string; finalized: boolean }>;
  toolArgumentTimer: ReturnType<typeof setTimeout> | null;
}

interface ClaudePendingInteraction {
  sessionId: string;
  queryGeneration: number;
  interactionId: string;
  requestId?: string;
  toolUseId?: string;
  kind: PendingInteractionKind;
  status: PendingInteractionStatus;
  expiresAt: number;
  suggestions: unknown[];
  input: JsonObject;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TOOL_ARGUMENT_STALL_TIMEOUT_MS = 90_000;
const CLAUDE_PLUGIN_NAME_PATTERN = /^[A-Za-z0-9._:-]{1,160}(?:@[A-Za-z0-9._:-]{1,160})?$/;
const CLAUDE_MARKETPLACE_NAME_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

function validateClaudePluginName(value: string, label = "插件名称") {
  if (!CLAUDE_PLUGIN_NAME_PATTERN.test(value)) throw new Error(`Claude ${label}格式无效。`);
  return value;
}

function validateClaudeMarketplaceName(value: string) {
  if (!CLAUDE_MARKETPLACE_NAME_PATTERN.test(value)) throw new Error("Claude 插件市场名称格式无效。");
  return value;
}

function validateClaudeMarketplaceSource(value: string, cwd: string) {
  if (/^(?:https?|git):\/\//i.test(value) || /^git@[^:]+:[^\s]+$/i.test(value) || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[A-Za-z0-9._/-]+)?$/.test(value)) return value;
  if (/^[.\\/]|^[A-Za-z]:[\\/]/.test(value)) {
    const resolved = canonicalWorkspace(path.resolve(cwd, value));
    if (!existsSync(resolved) || !isWithinDirectory(resolved, cwd)) throw new Error("Claude 本地插件市场必须位于已授权工作区内。");
    return resolved;
  }
  throw new Error("Claude 插件市场来源格式无效。");
}

export interface ClaudeGatewayFixtureConfig {
  kind: ClaudeGatewayFixtureKind;
  timeoutMs?: number;
  lifecycle?: ClaudeLifecycleFixtureKind;
}

export interface ClaudeWorkerRuntime {
  send(command: import("./claudeWorkerProtocol").ClaudeWorkerCommand): void;
  request(command: Exclude<import("./claudeWorkerProtocol").ClaudeWorkerCommand, { type: "start" | "send" | "interrupt" | "closeSession" | "testHoldRequests" | "testFatal" | "close" }>): Promise<unknown>;
  closeSession?(sessionId: string, queryGeneration?: number): Promise<void>;
  subscribe(listener: (event: ClaudeWorkerEvent) => void): () => void;
  close(): Promise<void>;
}

function textFromInput(input: unknown) {
  if (!Array.isArray(input)) return "";
  return input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "";
    const record = item as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string" ? record.text : "";
  }).filter(Boolean).join("\n");
}

function blocksFromInput(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function managedClaudePath() {
  const configured = process.env.CLAUDE_CODE_EXECUTABLE?.trim();
  if (configured && existsSync(configured)) return configured;
  const fromPath = resolveExecutableFromPath("claude.exe");
  if (fromPath) return fromPath;
  const value = path.join(homedir(), ".local", "bin", "claude.exe");
  if (existsSync(value)) return value;
  try { return require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude.exe`); } catch { return undefined; }
}

export class ClaudeBackend implements AgentBackend {
  readonly provider = "claude" as const;
  private readonly listeners = new Set<(event: AgentEventEnvelope) => void>();
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly interactions = new Map<string, ClaudePendingInteraction>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly runtime: ClaudeWorkerRuntime,
    private readonly interactionTimeoutMs = DEFAULT_INTERACTION_TIMEOUT_MS,
    private readonly credentialsReader: typeof readClaudeCredentials = readClaudeCredentials,
    private readonly gatewayFixtureReader?: () => ClaudeGatewayFixtureConfig | undefined,
    private readonly toolArgumentStallTimeoutMs = DEFAULT_TOOL_ARGUMENT_STALL_TIMEOUT_MS,
  ) {
    this.unsubscribe = runtime.subscribe((event) => this.handleWorkerEvent(event));
  }

  async request(operation: AgentOperation, params: JsonObject, context: AgentRequestContext) {
    if (operation === "getCapabilities") return this.getCapabilities();
    if (operation === "closeSession") return this.closeSession(context);
    if (operation === "startSession") return this.startSession(params, context);
    if (operation === "resumeSession") return this.resumeSession(params, context);
    if (operation === "listSessions") return this.listSessions(params, context);
    if (operation === "searchSessions") return this.searchSessions(params, context);
    if (operation === "readSession") return this.readSession(params, context);
    if (operation === "forkSession") return this.forkSession(params, context);
    if (operation === "renameSession") return this.renameSession(params, context);
    if (operation === "deleteSession") return this.deleteSession(params, context);
    if (operation === "listModels") return this.listModels(context);
    if (operation === "listSkills") return this.listSkills(params, context);
    if (operation === "updateSessionSettings") return this.updateSessionSettings(params, context);
    if (operation === "compactSession") return this.compactSession(context);
    if (operation === "listMcpServers") return this.listMcpServers(context);
    if (operation === "listPlugins") return this.pluginRequest("list", params, context);
    if (operation === "readPlugin") return this.pluginRequest("details", params, context);
    if (operation === "installPlugin") return this.pluginRequest("install", params, context);
    if (operation === "uninstallPlugin") return this.pluginRequest("uninstall", params, context);
    if (operation === "updatePlugin") return this.pluginRequest("update", params, context);
    if (operation === "addMarketplace") return this.pluginRequest("marketplaceAdd", params, context);
    if (operation === "updateMarketplace") return this.pluginRequest("marketplaceUpdate", params, context);
    if (operation === "removeMarketplace") return this.pluginRequest("marketplaceRemove", params, context);
    if (operation === "startTurn") return this.startTurn(params, context);
    if (operation === "interruptTurn") return this.interruptTurn(context);
    throw new Error(`Claude Code 暂不支持该操作：${operation}`);
  }

  async respondToInteraction(ref: InteractionRef, result: JsonObject) {
    if (ref.provider !== this.provider) throw new Error("Claude 交互 Provider 无效。");
    const session = this.sessions.get(ref.sessionId);
    if (!session || session.queryGeneration !== ref.queryGeneration || !session.queryActive) throw new Error("Claude Query 已失效。");
    const interaction = this.interactions.get(this.interactionKey(ref.sessionId, ref.queryGeneration, ref.interactionId));
    if (!interaction) throw new Error("Claude 交互不存在或已过期。");
    if (interaction.status !== "pending") throw new Error("Claude 交互已处理，不能重复响应。");
    if (ref.requestId !== undefined && String(ref.requestId) !== interaction.requestId) throw new Error("Claude 交互请求 ID 不匹配。");
    if (ref.toolUseId !== undefined && ref.toolUseId !== interaction.toolUseId) throw new Error("Claude 工具调用 ID 不匹配。");
    interaction.status = "resolving";
    clearTimeout(interaction.timer);
    const workerResult = this.normalizeInteractionResult(interaction, result);
    try {
      this.runtime.send({
        type: "interactionResponse",
        sessionId: interaction.sessionId,
        queryGeneration: interaction.queryGeneration,
        interactionId: interaction.interactionId,
        result: workerResult,
      });
      const terminal = this.interactionTerminalStatus(interaction, workerResult);
      this.finishInteraction(session, interaction, terminal);
    } catch (error) {
      this.finishInteraction(session, interaction, "failed");
      throw error;
    }
  }

  subscribeEvents(listener: (event: AgentEventEnvelope) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getCapabilities() {
    return { ...CAPABILITIES };
  }

  async closeSession(context: AgentRequestContext) {
    return this.closeSessionInternal(context, false);
  }

  async resetSession(context: AgentRequestContext) {
    return this.closeSessionInternal(context, true);
  }

  private async closeSessionInternal(context: AgentRequestContext, releaseBeforeWorkerClose: boolean) {
    const session = this.sessionFor(context);
    if (!session) return;
    this.clearToolTracking(session);
    this.cancelSessionInteractions(session, "cancelled");
    const queryGeneration = session.queryGeneration;
    session.queryGeneration += 1;
    session.queryActive = false;
    session.turnId = null;
    if (releaseBeforeWorkerClose) this.sessions.delete(session.clientSessionId);
    if (this.runtime.closeSession) await this.runtime.closeSession(session.clientSessionId, queryGeneration);
    else this.runtime.send({ type: "closeSession", sessionId: session.clientSessionId, queryGeneration });
    if (!releaseBeforeWorkerClose) this.sessions.delete(session.clientSessionId);
  }

  async close() {
    for (const session of this.sessions.values()) {
      this.clearToolTracking(session);
      this.cancelSessionInteractions(session, "cancelled");
    }
    this.sessions.clear();
    await this.runtime.close();
    this.unsubscribe();
  }

  async shutdownQueries() {
    for (const session of this.sessions.values()) {
      this.clearToolTracking(session);
      this.cancelSessionInteractions(session, "cancelled");
      this.emit(session, "claude/queryClosed", { nativeSessionId: session.nativeSessionId, reason: "backendRestart" });
    }
    this.sessions.clear();
    await this.runtime.close();
  }

  private startSession(params: JsonObject, context: AgentRequestContext) {
    const clientSessionId = context.sessionId;
    const cwdValue = typeof params.cwd === "string" ? params.cwd : context.canonicalCwd;
    if (!clientSessionId || !cwdValue) throw new Error("Claude 会话缺少客户端会话或工作区。");
    const cwd = canonicalWorkspace(cwdValue);
    if (this.sessions.has(clientSessionId)) throw new Error("Claude 客户端会话已存在，不能重复启动。");
    const nativeSessionId = randomUUID();
    const session: ClaudeSession = {
      clientSessionId,
      nativeSessionId,
      cwd,
      queryGeneration: 0,
      queryActive: false,
      turnId: null,
      model: typeof params.model === "string" ? params.model : "",
      effort: "",
      mode: "new",
      toolCalls: new Map(),
      toolArgumentTimer: null,
    };
    this.sessions.set(clientSessionId, session);
    this.rememberNativeSession(cwd, nativeSessionId);
    this.emit(session, "claude/sessionStarted", { nativeSessionId, cwd, title: "新会话" });
    return { thread: { id: nativeSessionId, cwd, name: "新会话" }, model: session.model, reasoningEffort: session.effort };
  }

  private async listSessions(params: JsonObject, context: AgentRequestContext) {
    const cwd = canonicalWorkspace(typeof params.cwd === "string" ? params.cwd : context.canonicalCwd || "");
    if (!cwd) throw new Error("Claude 历史缺少工作区。");
    const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 100);
    const cursor = typeof params.cursor === "string" && params.cursor ? Number(params.cursor) : 0;
    const result = await this.runtime.request({ type: "listSessions", cwd, limit, offset: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0, includeWorktrees: false });
    const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const data = Array.isArray(value.data) ? value.data : [];
    for (const item of data) {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      if (typeof record.id === "string") this.rememberNativeSession(cwd, record.id);
    }
    return { data, nextCursor: value.hasMore === true ? String((Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0) + data.length) : null };
  }

  private async searchSessions(params: JsonObject, context: AgentRequestContext) {
    const cwd = canonicalWorkspace(typeof params.cwd === "string" ? params.cwd : context.canonicalCwd || "");
    const searchTerm = typeof params.searchTerm === "string" ? params.searchTerm.trim() : "";
    if (!cwd || !searchTerm) return { data: [], nextCursor: null };
    const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 100);
    const cursor = typeof params.cursor === "string" && params.cursor ? Number(params.cursor) : 0;
    const result = await this.runtime.request({ type: "searchSessions", cwd, searchTerm, limit, offset: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0, includeWorktrees: false });
    const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const data = Array.isArray(value.data) ? value.data : [];
    const scannedCount = typeof value.scannedCount === "number" && Number.isSafeInteger(value.scannedCount) && value.scannedCount >= 0
      ? value.scannedCount
      : data.length;
    return { data, nextCursor: value.hasMore === true ? String((Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0) + scannedCount) : null };
  }

  private async readSession(params: JsonObject, context: AgentRequestContext) {
    const { cwd, nativeSessionId } = this.sessionIdentity(params, context);
    await this.assertKnownNativeSession(cwd, nativeSessionId);
    const result = await this.runtime.request({ type: "readSession", cwd, nativeSessionId });
    const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const info = value.info && typeof value.info === "object" ? value.info as Record<string, unknown> : {};
    const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : "";
    return { thread: { ...info, id: nativeSessionId, cwd, ...(model ? { model } : {}), messages: Array.isArray(value.messages) ? value.messages : [] } };
  }

  private async resumeSession(params: JsonObject, context: AgentRequestContext) {
    const clientSessionId = context.sessionId;
    const { cwd, nativeSessionId } = this.sessionIdentity(params, context);
    if (!clientSessionId) throw new Error("Claude 恢复缺少客户端会话。");
    await this.assertKnownNativeSession(cwd, nativeSessionId);
    const existing = this.sessions.get(clientSessionId);
    if (existing?.queryActive) throw new Error("活动 Claude Query 不能被恢复请求覆盖。");
    if (existing && (existing.cwd !== cwd || existing.nativeSessionId !== nativeSessionId)) throw new Error("Claude 客户端会话归属与恢复请求不一致。");
    const session: ClaudeSession = existing || {
      clientSessionId,
      nativeSessionId,
      cwd,
      queryGeneration: 0,
      queryActive: false,
      turnId: null,
      model: "",
      effort: "",
      resumeNativeSessionId: nativeSessionId,
      mode: "resume",
      toolCalls: new Map(),
      toolArgumentTimer: null,
    };
    this.clearToolTracking(session);
    session.nativeSessionId = nativeSessionId;
    session.cwd = cwd;
    session.resumeNativeSessionId = nativeSessionId;
    session.mode = "resume";
    this.sessions.set(clientSessionId, session);
    return { thread: { id: nativeSessionId, cwd }, model: session.model, reasoningEffort: session.effort };
  }

  private async forkSession(params: JsonObject, context: AgentRequestContext) {
    const { cwd, nativeSessionId } = this.sessionIdentity(params, context);
    await this.assertKnownNativeSession(cwd, nativeSessionId);
    const result = await this.runtime.request({ type: "forkSession", cwd, nativeSessionId, ...(typeof params.title === "string" ? { title: params.title } : {}) });
    const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const forkedId = typeof value.sessionId === "string" ? value.sessionId : "";
    if (!forkedId) throw new Error("Claude 分支没有返回会话 ID。");
    this.rememberNativeSession(cwd, forkedId);
    return { thread: { id: forkedId, cwd, name: typeof params.title === "string" ? params.title : "分支会话" } };
  }

  private async renameSession(params: JsonObject, context: AgentRequestContext) {
    const { cwd, nativeSessionId } = this.sessionIdentity(params, context);
    await this.assertKnownNativeSession(cwd, nativeSessionId);
    const title = typeof params.name === "string" ? params.name.trim() : "";
    if (!title) throw new Error("Claude 会话名称不能为空。");
    await this.runtime.request({ type: "renameSession", cwd, nativeSessionId, title });
    return { ok: true };
  }

  private async deleteSession(params: JsonObject, context: AgentRequestContext) {
    const { cwd, nativeSessionId } = this.sessionIdentity(params, context);
    await this.assertKnownNativeSession(cwd, nativeSessionId);
    await this.runtime.request({ type: "deleteSession", cwd, nativeSessionId });
    return { ok: true };
  }

  private startTurn(params: JsonObject, context: AgentRequestContext) {
    const session = this.requireSession(context);
    const text = textFromInput(params.input);
    const inputBlocks = blocksFromInput(params.input);
    if (!text && !inputBlocks.some((item) => item.type === "localImage")) throw new Error("Claude Code 输入不能为空。");
    this.clearToolTracking(session);
    const turnId = randomUUID();
    session.turnId = turnId;
    if (!session.queryActive) {
      let credential: ReturnType<typeof readClaudeCredentials>;
      try {
        credential = this.credentialsReader();
      } catch (error) {
        session.turnId = null;
        throw error;
      }
      this.cancelSessionInteractions(session, "cancelled");
      session.queryGeneration += 1;
      session.queryActive = true;
      const env = credential.source === "process" ? credentialEnv(credential) : undefined;
      const pendingStart = { queryGeneration: session.queryGeneration, resumeNativeSessionId: session.resumeNativeSessionId, mode: session.mode };
      session.pendingStart = pendingStart;
      try {
        const gatewayFixture = this.gatewayFixtureReader?.();
        this.runtime.send({
          type: "start",
          sessionId: session.clientSessionId,
          nativeSessionId: session.nativeSessionId,
          ...(session.resumeNativeSessionId ? { resumeSessionId: session.resumeNativeSessionId } : {}),
          queryGeneration: session.queryGeneration,
          cwd: session.cwd,
          prompt: text,
          input: inputBlocks,
          model: typeof params.model === "string" ? params.model : session.model,
          effort: typeof params.effort === "string" ? params.effort : session.effort,
          executablePath: managedClaudePath(),
          ...(env ? { env } : {}),
          settingSources: credential.source === "settings" ? ["user", "project", "local"] : [],
          ...(gatewayFixture ? { gatewayFixture } : {}),
        });
      } catch (error) {
        session.queryActive = false;
        session.pendingStart = undefined;
        session.turnId = null;
        throw error;
      } finally {
        if (env) for (const key of Object.keys(env)) delete env[key];
      }
    } else {
      this.runtime.send({ type: "send", sessionId: session.clientSessionId, queryGeneration: session.queryGeneration, text, input: inputBlocks });
    }
    this.emit(session, "claude/turnStarted", { nativeSessionId: session.nativeSessionId, turnId });
    return { turn: { id: turnId, status: "inProgress" } };
  }

  private async listModels(context: AgentRequestContext) {
    const session = this.requireSession(context);
    const queryGeneration = session.queryGeneration;
    const models = await this.controlAtGeneration(session, queryGeneration, "models");
    this.assertCurrentQuery(session, queryGeneration);
    return { data: Array.isArray(models) ? models : [] };
  }

  private async listSkills(params: JsonObject, context: AgentRequestContext) {
    const session = this.requireSession(context);
    const queryGeneration = session.queryGeneration;
    const commands = await this.controlAtGeneration(session, queryGeneration, "commands");
    this.assertCurrentQuery(session, queryGeneration);
    const cwd = typeof params.cwd === "string" ? params.cwd : session.cwd;
    return { data: [{ cwd, skills: Array.isArray(commands) ? commands : [] }] };
  }

  private async updateSessionSettings(params: JsonObject, context: AgentRequestContext) {
    const session = this.requireSession(context);
    const queryGeneration = session.queryGeneration;
    const queryWasActive = session.queryActive;
    if (typeof params.model === "string" && params.model) {
      if (queryWasActive) await this.controlAtGeneration(session, queryGeneration, "setModel", params.model);
      this.assertCurrentGeneration(session, queryGeneration, queryWasActive);
      session.model = params.model;
    }
    if (typeof params.effort === "string" && params.effort) {
      if (queryWasActive) await this.controlAtGeneration(session, queryGeneration, "setEffort", params.effort);
      this.assertCurrentGeneration(session, queryGeneration, queryWasActive);
      session.effort = params.effort;
    }
    this.assertCurrentGeneration(session, queryGeneration, queryWasActive);
    this.emit(session, "claude/sessionSettingsUpdated", { nativeSessionId: session.nativeSessionId, model: session.model, effort: session.effort });
    return { ok: true, model: session.model, effort: session.effort };
  }

  private async compactSession(context: AgentRequestContext) {
    const session = this.requireSession(context);
    if (!session.queryActive) throw new Error("Claude Code 当前没有可压缩的活动 Query。");
    const credential = this.credentialsReader();
    const env = credential.source === "process" ? credentialEnv(credential) : undefined;
    const gatewayFixture = this.gatewayFixtureReader?.();
    const previousGeneration = session.queryGeneration;
    this.cancelSessionInteractions(session, "cancelled");
    session.queryGeneration += 1;
    session.queryActive = false;
    session.turnId = null;
    session.pendingStart = undefined;
    session.resumeNativeSessionId = session.nativeSessionId;
    session.mode = "resume";
    this.emit(session, "claude/queryRestarted", { nativeSessionId: session.nativeSessionId, reason: "compact" });
    if (this.runtime.closeSession) await this.runtime.closeSession(session.clientSessionId, previousGeneration);
    else this.runtime.send({ type: "closeSession", sessionId: session.clientSessionId, queryGeneration: previousGeneration });

    try {
      return await this.runtime.request({
        type: "compactSession",
        sessionId: session.clientSessionId,
        nativeSessionId: session.nativeSessionId,
        queryGeneration: session.queryGeneration,
        cwd: session.cwd,
        model: session.model || undefined,
        effort: session.effort || undefined,
        executablePath: managedClaudePath(),
        ...(env ? { env } : {}),
        settingSources: credential.source === "settings" ? ["user", "project", "local"] : [],
        ...(gatewayFixture ? { gatewayFixture } : {}),
      });
    } finally {
      if (env) for (const key of Object.keys(env)) delete env[key];
    }
  }

  private listMcpServers(context: AgentRequestContext) {
    return this.control(this.requireSession(context), "mcp");
  }

  private async pluginRequest(operation: ClaudePluginOperation, params: JsonObject, context: AgentRequestContext) {
    const cwdValue = typeof params.cwd === "string" ? params.cwd : context.canonicalCwd;
    if (!cwdValue) throw new Error("Claude 插件操作缺少工作区。");
    const cwd = canonicalWorkspace(cwdValue);
    const pluginName = typeof params.pluginName === "string" ? params.pluginName : typeof params.pluginId === "string" ? params.pluginId : undefined;
    const remoteMarketplace = typeof params.remoteMarketplaceName === "string" ? params.remoteMarketplaceName : undefined;
    const plugin = pluginName && remoteMarketplace && !pluginName.includes("@") ? `${pluginName}@${remoteMarketplace}` : pluginName;
    const marketplace = typeof params.marketplaceName === "string" ? params.marketplaceName : undefined;
    const source = typeof params.source === "string" ? params.source : undefined;
    if (["details", "install", "uninstall", "update"].includes(operation) && plugin) validateClaudePluginName(plugin);
    if (["marketplaceUpdate", "marketplaceRemove"].includes(operation) && marketplace) validateClaudeMarketplaceName(marketplace);
    const validatedSource = operation === "marketplaceAdd" && source ? validateClaudeMarketplaceSource(source, cwd) : source;
    const credential = this.credentialsReader();
    const env = credential.source === "process" ? credentialEnv(credential) : undefined;
    const result = await this.runtime.request({
      type: "plugin",
      operation,
      cwd,
      executablePath: managedClaudePath(),
      ...(env ? { env } : {}),
      ...(plugin ? { plugin } : {}),
      ...(marketplace ? { marketplace } : {}),
      ...(validatedSource ? { source: validatedSource } : {}),
      ...(Array.isArray(params.sparsePaths) ? { sparsePaths: params.sparsePaths.filter((entry): entry is string => typeof entry === "string").slice(0, 32) } : {}),
    });
    if (env) for (const key of Object.keys(env)) delete env[key];
    if (operation !== "install" && operation !== "uninstall" && operation !== "update") return result;
    let reloaded = 0;
    for (const session of this.sessions.values()) {
      if (session.cwd !== cwd || !session.queryActive) continue;
      const queryGeneration = session.queryGeneration;
      try {
        await this.controlAtGeneration(session, queryGeneration, "reloadPlugins");
        this.assertCurrentQuery(session, queryGeneration);
        reloaded += 1;
      } catch {
        // 插件管理成功不应因某个旧 Query 不支持热加载而回滚。
      }
    }
    return result && typeof result === "object" && !Array.isArray(result) ? { ...(result as JsonObject), reloaded } : { ok: true, reloaded };
  }

  private async contextUsage(session: ClaudeSession, queryGeneration: number) {
    const result = await this.controlAtGeneration(session, queryGeneration, "contextUsage");
    this.assertCurrentQuery(session, queryGeneration);
    const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
    return {
      used: typeof value.totalTokens === "number" && Number.isFinite(value.totalTokens) ? value.totalTokens : 0,
      total: typeof value.maxTokens === "number" && Number.isFinite(value.maxTokens) ? value.maxTokens : null,
    };
  }

  private control(session: ClaudeSession, action: Extract<import("./claudeWorkerProtocol").ClaudeWorkerCommand, { type: "control" }>["action"], value?: string) {
    return this.controlAtGeneration(session, session.queryGeneration, action, value);
  }

  private controlAtGeneration(session: ClaudeSession, queryGeneration: number, action: Extract<import("./claudeWorkerProtocol").ClaudeWorkerCommand, { type: "control" }>["action"], value?: string) {
    this.assertCurrentQuery(session, queryGeneration);
    return this.runtime.request({ type: "control", sessionId: session.clientSessionId, queryGeneration, action, ...(value ? { value } : {}) });
  }

  private assertCurrentGeneration(session: ClaudeSession, queryGeneration: number, requireActive = false) {
    if (this.sessions.get(session.clientSessionId) !== session
      || session.queryGeneration !== queryGeneration
      || (requireActive && !session.queryActive)) throw new Error("Claude Query 已失效。");
  }

  private assertCurrentQuery(session: ClaudeSession, queryGeneration: number) {
    this.assertCurrentGeneration(session, queryGeneration, true);
  }

  private emitForQuery(session: ClaudeSession, queryGeneration: number, type: string, payload: unknown) {
    if (this.sessions.get(session.clientSessionId) !== session || session.queryGeneration !== queryGeneration || !session.queryActive) return false;
    this.emit(session, type, payload);
    return true;
  }

  private interruptTurn(context: AgentRequestContext) {
    const session = this.requireSession(context);
    if (!session.queryActive) throw new Error("Claude Code 当前没有运行中的任务。");
    this.runtime.send({ type: "interrupt", sessionId: session.clientSessionId, queryGeneration: session.queryGeneration });
    return { turnId: session.turnId };
  }

  private handleWorkerEvent(event: ClaudeWorkerEvent) {
    if (event.type === "response" || event.type === "cleanupComplete") return;
    if (event.type === "fatal") {
      for (const session of this.sessions.values()) {
        this.clearToolTracking(session);
        this.cancelSessionInteractions(session, "failed");
        session.queryActive = false;
        session.pendingStart = undefined;
        this.emit(session, "claude/backendExited", { message: event.message });
      }
      return;
    }
    const session = event.sessionId ? this.sessions.get(event.sessionId) : undefined;
    if (!session) return;
    if (event.queryGeneration !== session.queryGeneration) {
      this.emit(session, "claude/staleEvent", { eventType: event.type });
      return;
    }
    if (event.type === "ready") {
      if (session.pendingStart && session.pendingStart.queryGeneration === session.queryGeneration) {
        session.resumeNativeSessionId = undefined;
        session.mode = "new";
        session.pendingStart = undefined;
      }
      if (event.nativeSessionId) {
        session.nativeSessionId = event.nativeSessionId;
        this.rememberNativeSession(session.cwd, event.nativeSessionId);
      }
      const queryGeneration = event.queryGeneration;
      this.emit(session, "claude/ready", { nativeSessionId: event.nativeSessionId || session.nativeSessionId });
      const emitCapability = (capabilities: Partial<AgentCapabilities>, extra: JsonObject = {}) => this.emitForQuery(session, queryGeneration, "claude/capabilitiesUpdated", { nativeSessionId: session.nativeSessionId, capabilities, ...extra });
      const unsupported = (error: unknown) => /不受支持|not supported|not a function|不存在/i.test(error instanceof Error ? error.message : String(error));
      void this.controlAtGeneration(session, queryGeneration, "models").then((models) => {
        const modelList = Array.isArray(models) ? models : [];
        const hasEffort = modelList.some((entry) => entry && typeof entry === "object" && Array.isArray((entry as Record<string, unknown>).supportedEffortLevels) && ((entry as Record<string, unknown>).supportedEffortLevels as unknown[]).length > 0);
        emitCapability({ models: "supported", effort: hasEffort ? "supported" : "unsupported" }, { models: modelList });
      }).catch((error) => emitCapability({ models: unsupported(error) ? "unsupported" : "temporarilyUnavailable", effort: unsupported(error) ? "unsupported" : "temporarilyUnavailable" }));
      void this.controlAtGeneration(session, queryGeneration, "commands").then((commands) => {
        const commandList = Array.isArray(commands) ? commands : [];
        const hasCompact = commandList.some((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).name === "compact");
        emitCapability({ commands: "supported", compact: hasCompact ? "supported" : "unsupported" }, { commands: commandList });
      }).catch((error) => {
        const state = unsupported(error) ? "unsupported" : "temporarilyUnavailable";
        emitCapability({ commands: state, compact: state });
      });
      void this.controlAtGeneration(session, queryGeneration, "reloadSkills").then(() => emitCapability({ skills: "supported" })).catch((error) => emitCapability({ skills: unsupported(error) ? "unsupported" : "temporarilyUnavailable" }));
      void this.controlAtGeneration(session, queryGeneration, "mcp").then(() => emitCapability({ mcp: "supported" })).catch((error) => emitCapability({ mcp: unsupported(error) ? "unsupported" : "temporarilyUnavailable" }));
      void this.controlAtGeneration(session, queryGeneration, "reloadPlugins").then(() => emitCapability({ pluginsLoad: "supported" })).catch((error) => emitCapability({ pluginsLoad: unsupported(error) ? "unsupported" : "temporarilyUnavailable" }));
      void this.controlAtGeneration(session, queryGeneration, "agents").then(() => emitCapability({ subagents: "supported" })).catch((error) => emitCapability({ subagents: unsupported(error) ? "unsupported" : "temporarilyUnavailable" }));
      void this.contextUsage(session, queryGeneration).then((usage) => {
        emitCapability({ contextUsage: "supported" });
        this.emitForQuery(session, queryGeneration, "claude/contextUsage", { nativeSessionId: session.nativeSessionId, ...usage });
      }).catch((error) => {
        emitCapability({ contextUsage: unsupported(error) ? "unsupported" : "temporarilyUnavailable" });
        this.emitForQuery(session, queryGeneration, "claude/contextUsageFailed", {
          nativeSessionId: session.nativeSessionId,
          phase: "ready",
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (event.type === "processStarted") {
      this.emit(session, "claude/processStarted", { nativeSessionId: session.nativeSessionId, rootPid: event.rootPid });
      return;
    }
    if (event.type === "message") {
      const inspected = this.inspectToolLifecycle(session, event.payload);
      const payload = inspected.payload;
      this.emit(session, "claude/sdkMessage", payload);
      if (inspected.integrityFailure) {
        session.turnId = null;
        this.breakQueryForRecovery(session);
        return;
      }
      if (payload.type === "result") {
        session.turnId = null;
      }
      if (payload.type === "result" && payload.gatewayError) {
        this.cancelSessionInteractions(session, "failed");
        session.queryActive = false;
        session.pendingStart = undefined;
        session.turnId = null;
      }
      if (payload.type === "result" && session.queryActive) {
        const queryGeneration = event.queryGeneration;
        void this.contextUsage(session, queryGeneration)
        .then((usage) => this.emitForQuery(session, queryGeneration, "claude/contextUsage", { nativeSessionId: session.nativeSessionId, ...usage }))
        .catch((error) => this.emitForQuery(session, queryGeneration, "claude/contextUsageFailed", {
          nativeSessionId: session.nativeSessionId,
          phase: "result",
          message: error instanceof Error ? error.message : String(error),
        }));
      }
      return;
    }
    if (event.type === "interactionPending") {
      this.registerInteraction(session, event);
      return;
    }
    if (event.type === "interactionFinished") {
      const interaction = this.interactions.get(this.interactionKey(session.clientSessionId, event.queryGeneration, event.interactionId));
      if (interaction?.status === "pending" || interaction?.status === "resolving") {
        this.finishInteraction(session, interaction, event.status === "cancelled" ? "cancelled" : "resolved");
      }
      return;
    }
    if (event.type === "interrupted") {
      this.clearToolTracking(session);
      session.turnId = null;
      if (session.pendingStart) {
        session.queryActive = false;
        session.pendingStart = undefined;
      }
      this.emit(session, "claude/turnCompleted", { nativeSessionId: session.nativeSessionId, status: "interrupted" });
      return;
    }
    if (event.type === "closed") {
      this.clearToolTracking(session);
      this.cancelSessionInteractions(session, "cancelled");
      session.queryActive = false;
      session.turnId = null;
      session.pendingStart = undefined;
      this.emit(session, "claude/queryClosed", { nativeSessionId: session.nativeSessionId });
      return;
    }
    if (event.type === "error") {
      this.clearToolTracking(session);
      this.cancelSessionInteractions(session, "failed");
      session.queryActive = false;
      session.pendingStart = undefined;
      session.turnId = null;
      this.emit(session, "claude/error", { nativeSessionId: session.nativeSessionId, message: event.message, ...(event.payload ? { gatewayError: event.payload } : {}) });
    }
  }

  private inspectToolLifecycle(session: ClaudeSession, value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { payload: {} as Record<string, unknown>, integrityFailure: false };
    const payload = value as Record<string, unknown>;
    const type = typeof payload.type === "string" ? payload.type : "";
    if (type === "stream_event") {
      const stream = payload.event && typeof payload.event === "object" && !Array.isArray(payload.event) ? payload.event as Record<string, unknown> : {};
      if (stream.type === "content_block_start") {
        const block = stream.content_block && typeof stream.content_block === "object" && !Array.isArray(stream.content_block) ? stream.content_block as Record<string, unknown> : {};
        const id = typeof block.id === "string" ? block.id : "";
        if (block.type === "tool_use" && id) {
          session.toolCalls.set(id, { name: typeof block.name === "string" ? block.name : "Claude 工具", finalized: false });
          this.refreshToolArgumentTimer(session);
        }
      } else if (stream.type === "content_block_delta") {
        const delta = stream.delta && typeof stream.delta === "object" && !Array.isArray(stream.delta) ? stream.delta as Record<string, unknown> : {};
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json.length > 0) {
          this.refreshToolArgumentTimer(session);
        }
      }
      return { payload, integrityFailure: false };
    }
    const message = payload.message && typeof payload.message === "object" && !Array.isArray(payload.message) ? payload.message as Record<string, unknown> : {};
    const content = Array.isArray(message.content) ? message.content : [];
    if (type === "assistant") {
      for (const value of content) {
        const block = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const id = typeof block.id === "string" ? block.id : "";
        if (block.type !== "tool_use" || !id) continue;
        const existing = session.toolCalls.get(id);
        session.toolCalls.set(id, { name: typeof block.name === "string" ? block.name : existing?.name || "Claude 工具", finalized: true });
      }
      this.refreshToolArgumentTimer(session);
      return { payload, integrityFailure: false };
    }
    if (type === "user") {
      for (const value of content) {
        const block = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") session.toolCalls.delete(block.tool_use_id);
      }
      this.refreshToolArgumentTimer(session);
      return { payload, integrityFailure: false };
    }
    if (type !== "result") return { payload, integrityFailure: false };
    const incomplete = [...session.toolCalls.entries()].map(([id, state]) => ({ id, ...state }));
    this.clearToolTracking(session);
    if (payload.is_error === true || !incomplete.length) return { payload, integrityFailure: false };
    const messageText = this.toolIntegrityMessage(incomplete, false);
    return {
      payload: {
        ...payload,
        subtype: "error_incomplete_tool_use",
        is_error: true,
        errors: [messageText],
        agentdeskProtocolError: {
          kind: "incompleteToolUse",
          tools: incomplete.map(({ id, name, finalized }) => ({ id, name, finalized })),
        },
      },
      integrityFailure: true,
    };
  }

  private refreshToolArgumentTimer(session: ClaudeSession) {
    if (session.toolArgumentTimer) clearTimeout(session.toolArgumentTimer);
    session.toolArgumentTimer = null;
    if (!(this.toolArgumentStallTimeoutMs > 0) || ![...session.toolCalls.values()].some((tool) => !tool.finalized)) return;
    const queryGeneration = session.queryGeneration;
    session.toolArgumentTimer = setTimeout(() => {
      if (session.queryGeneration !== queryGeneration) return;
      const stalled = [...session.toolCalls.entries()].filter(([, state]) => !state.finalized).map(([id, state]) => ({ id, ...state }));
      if (!stalled.length) return;
      const message = this.toolIntegrityMessage(stalled, true);
      this.emit(session, "claude/error", {
        nativeSessionId: session.nativeSessionId,
        message,
        protocolError: { kind: "toolArgumentStalled", tools: stalled.map(({ id, name }) => ({ id, name })) },
      });
      session.turnId = null;
      this.breakQueryForRecovery(session);
    }, this.toolArgumentStallTimeoutMs);
  }

  private toolIntegrityMessage(tools: Array<{ name: string }>, stalled: boolean) {
    const names = [...new Set(tools.map((tool) => tool.name || "Claude 工具"))];
    const label = names.join("、") || "Claude 工具";
    const affectsFiles = names.some((name) => name === "Write" || name === "Edit");
    if (stalled) return affectsFiles
      ? `Claude 的 ${label} 工具参数长时间没有继续生成，已中止本次执行，文件未写入。请继续当前会话重试。`
      : `Claude 的 ${label} 工具参数长时间没有继续生成，已中止本次执行。请继续当前会话重试。`;
    return affectsFiles
      ? `Claude 的 ${label} 工具调用未完整执行，文件未写入。请继续当前会话重试。`
      : `Claude 的 ${label} 工具调用未完整执行，执行结果未生效。请继续当前会话重试。`;
  }

  private clearToolTracking(session: ClaudeSession) {
    if (session.toolArgumentTimer) clearTimeout(session.toolArgumentTimer);
    session.toolArgumentTimer = null;
    session.toolCalls.clear();
  }

  private breakQueryForRecovery(session: ClaudeSession) {
    const queryGeneration = session.queryGeneration;
    this.clearToolTracking(session);
    this.cancelSessionInteractions(session, "failed");
    session.queryActive = false;
    session.pendingStart = undefined;
    session.turnId = null;
    session.resumeNativeSessionId = session.nativeSessionId;
    session.mode = "resume";
    session.queryGeneration += 1;
    this.emit(session, "claude/queryRestarted", { nativeSessionId: session.nativeSessionId, reason: "recovery" });
    if (this.runtime.closeSession) void this.runtime.closeSession(session.clientSessionId, queryGeneration).catch(() => undefined);
    else {
      try { this.runtime.send({ type: "closeSession", sessionId: session.clientSessionId, queryGeneration }); } catch { /* recovery will retry with a new Query */ }
    }
  }

  private sessionFor(context: AgentRequestContext) {
    if (context.sessionId) return this.sessions.get(context.sessionId);
    if (context.nativeSessionId) return [...this.sessions.values()].find((session) => session.nativeSessionId === context.nativeSessionId);
    return undefined;
  }

  private sessionIdentity(params: JsonObject, context: AgentRequestContext) {
    const cwdValue = typeof params.cwd === "string" ? params.cwd : context.canonicalCwd;
    const nativeSessionId = typeof params.threadId === "string" ? params.threadId : context.nativeSessionId;
    if (!cwdValue || !nativeSessionId) throw new Error("Claude 会话缺少完整的工作区和原生会话 ID。");
    const cwd = canonicalWorkspace(cwdValue);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nativeSessionId)) throw new Error("Claude 原生会话 ID 无效。");
    return { cwd, nativeSessionId };
  }

  private readonly knownNativeSessions = new Set<string>();

  private rememberNativeSession(cwd: string, nativeSessionId: string) {
    this.knownNativeSessions.add(`${cwd}\u0000${nativeSessionId}`);
  }

  private async assertKnownNativeSession(cwd: string, nativeSessionId: string) {
    if (this.knownNativeSessions.has(`${cwd}\u0000${nativeSessionId}`)) return;
    const info = await this.runtime.request({ type: "getSessionInfo", cwd, nativeSessionId });
    if (!info || typeof info !== "object") throw new Error("Claude 会话不存在或不属于当前工作区。");
    this.rememberNativeSession(cwd, nativeSessionId);
  }

  private requireSession(context: AgentRequestContext) {
    const session = this.sessionFor(context);
    if (!session) throw new Error("Claude 会话不存在或已关闭。");
    if (context.canonicalCwd && canonicalWorkspace(context.canonicalCwd) !== session.cwd) throw new Error("Claude 会话工作区归属不匹配。");
    if (context.nativeSessionId && context.nativeSessionId !== session.nativeSessionId) throw new Error("Claude 原生会话归属不匹配。");
    if (context.queryGeneration !== undefined && context.queryGeneration !== session.queryGeneration) throw new Error("Claude Query 代次已失效。");
    return session;
  }

  private interactionKey(sessionId: string, queryGeneration: number, interactionId: string) {
    return `${sessionId}\u0000${queryGeneration}\u0000${interactionId}`;
  }

  private registerInteraction(session: ClaudeSession, event: Extract<ClaudeWorkerEvent, { type: "interactionPending" }>) {
    if (!event.interactionId || event.interactionId.length > 512) return;
    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload : {};
    const key = this.interactionKey(session.clientSessionId, event.queryGeneration, event.interactionId);
    const existing = this.interactions.get(key);
    if (existing) {
      if (existing.status === "pending" || existing.status === "resolving") return;
      this.emit(session, "claude/staleInteraction", { interactionId: event.interactionId, status: existing.status });
      return;
    }
    const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
    const toolUseId = typeof payload.toolUseId === "string" ? payload.toolUseId : undefined;
    const input = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input) ? payload.input as JsonObject : {};
    const suggestions = Array.isArray(payload.suggestions) ? payload.suggestions : [];
    const expiresAt = Date.now() + this.interactionTimeoutMs;
    const interaction: ClaudePendingInteraction = {
      sessionId: session.clientSessionId,
      queryGeneration: event.queryGeneration,
      interactionId: event.interactionId,
      ...(requestId ? { requestId } : {}),
      ...(toolUseId ? { toolUseId } : {}),
      kind: event.kind,
      status: "pending",
      expiresAt,
      suggestions,
      input,
      timer: setTimeout(() => this.expireInteraction(key), this.interactionTimeoutMs),
    };
    this.interactions.set(key, interaction);
    this.emit(session, "claude/interactionPending", {
      ...payload,
      interactionId: event.interactionId,
      queryGeneration: event.queryGeneration,
      kind: event.kind,
      expiresAt,
    });
  }

  private expireInteraction(key: string) {
    const interaction = this.interactions.get(key);
    const session = interaction ? this.sessions.get(interaction.sessionId) : undefined;
    if (!interaction || !session || interaction.status !== "pending") return;
    interaction.status = "resolving";
    try {
      this.runtime.send({
        type: "interactionResponse",
        sessionId: interaction.sessionId,
        queryGeneration: interaction.queryGeneration,
        interactionId: interaction.interactionId,
        result: interaction.kind === "mcpElicitation"
          ? { action: "cancel" }
          : { behavior: "deny", message: "Claude 交互等待超时。", interrupt: false, ...(interaction.toolUseId ? { toolUseID: interaction.toolUseId } : {}) },
      });
    } catch {
      // Worker 可能已退出，主进程仍需将交互结算为过期。
    }
    this.finishInteraction(session, interaction, "expired");
  }

  private cancelSessionInteractions(session: ClaudeSession, status: "cancelled" | "failed") {
    for (const interaction of this.interactions.values()) {
      if (interaction.sessionId !== session.clientSessionId || interaction.status !== "pending") continue;
      this.finishInteraction(session, interaction, status);
    }
  }

  private finishInteraction(session: ClaudeSession, interaction: ClaudePendingInteraction, status: Exclude<PendingInteractionStatus, "pending" | "resolving">) {
    if (interaction.status !== "pending" && interaction.status !== "resolving") return;
    clearTimeout(interaction.timer);
    interaction.status = status;
    this.emit(session, "claude/interactionFinished", { interactionId: interaction.interactionId, status });
  }

  private normalizeInteractionResult(interaction: ClaudePendingInteraction, result: JsonObject): JsonObject {
    if (interaction.kind === "mcpElicitation") {
      const action = result.action === "accept" || result.action === "decline" || result.action === "cancel" ? result.action : "cancel";
      const content = result.content && typeof result.content === "object" && !Array.isArray(result.content) ? result.content : undefined;
      return action === "accept" ? { action, ...(content ? { content } : {}) } : { action };
    }
    if (interaction.kind === "userQuestion") {
      const submitted = result.answers && typeof result.answers === "object" && !Array.isArray(result.answers) ? result.answers as JsonObject : {};
      if (!Object.keys(submitted).length) return { behavior: "deny", message: "用户取消了问题。", interrupt: false, ...(interaction.toolUseId ? { toolUseID: interaction.toolUseId } : {}) };
      const questions = Array.isArray(interaction.input.questions) ? interaction.input.questions : [];
      const answers: JsonObject = {};
      questions.forEach((value, index) => {
        const question = value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
        const title = typeof question.question === "string" ? question.question : String(index);
        const answer = submitted[String(index)] && typeof submitted[String(index)] === "object" && !Array.isArray(submitted[String(index)]) ? submitted[String(index)] as JsonObject : {};
        const values = Array.isArray(answer.answers) ? answer.answers.filter((entry): entry is string => typeof entry === "string") : [];
        if (values.length) answers[title] = values.join(", ");
      });
      return {
        behavior: "allow",
        updatedInput: { ...interaction.input, answers },
        ...(interaction.toolUseId ? { toolUseID: interaction.toolUseId } : {}),
      };
    }
    const decision = typeof result.decision === "string" ? result.decision : typeof result.behavior === "string" ? result.behavior : "deny";
    if (decision === "accept" || decision === "acceptForSession" || decision === "allow") {
      return {
        behavior: "allow",
        ...(decision === "acceptForSession" && interaction.suggestions.length ? { updatedPermissions: interaction.suggestions } : {}),
        ...(interaction.toolUseId ? { toolUseID: interaction.toolUseId } : {}),
      };
    }
    return {
      behavior: "deny",
      message: decision === "cancel" ? "用户取消了权限请求。" : "用户拒绝了权限请求。",
      interrupt: false,
      ...(interaction.toolUseId ? { toolUseID: interaction.toolUseId } : {}),
    };
  }

  private interactionTerminalStatus(interaction: ClaudePendingInteraction, result: JsonObject): Exclude<PendingInteractionStatus, "pending" | "resolving"> {
    if (interaction.kind === "mcpElicitation") return result.action === "accept" ? "resolved" : result.action === "decline" ? "rejected" : "cancelled";
    if (result.behavior === "allow") return "resolved";
    return result.message === "用户取消了权限请求。" || result.message === "用户取消了问题。" ? "cancelled" : "rejected";
  }

  private emit(session: ClaudeSession, type: string, payload: unknown) {
    const event: AgentEventEnvelope = {
      provider: this.provider,
      sessionId: session.clientSessionId,
      queryGeneration: session.queryGeneration,
      receivedAt: Date.now(),
      type,
      payload,
    };
    this.listeners.forEach((listener) => listener(event));
  }
}
