import type { AgentEventEnvelope, AgentOperation, AgentProvider, AgentRequestContext, InteractionRef } from "../../shared/agentProtocol";
import { decodeCodexRpcError, type JsonObject } from "../../shared/protocol";
import { canonicalPath } from "../localPathPolicy";

interface RegisteredSession {
  provider: AgentProvider;
  clientSessionId: string;
  canonicalCwd: string;
  nativeSessionId?: string;
  queryGeneration: number;
  queryActive: boolean;
}

export interface RendererSessionRegistration {
  provider: AgentProvider;
  context: AgentRequestContext;
  queryActive: boolean;
}

interface RegisteredInteraction {
  provider: AgentProvider;
  sessionId: string;
  nativeSessionId: string;
  queryGeneration: number;
  interactionId: string;
  requestId: number | string;
  expiresAt: number;
  status: "pending" | "resolving" | "finished";
}

interface ClosedSessionGrant {
  provider: AgentProvider;
  canonicalCwd: string;
  nativeSessionId: string;
  expiresAt: number;
}

const SESSION_OPERATIONS = new Set<AgentOperation>([
  "listModels", "listSkills", "readSession", "forkSession", "renameSession", "deleteSession",
  "updateSessionMetadata", "updateSessionSettings", "startTurn", "startReview", "steerTurn", "interruptTurn",
  "compactSession", "readRateLimits", "listMcpServers", "getGoal", "setGoal", "clearGoal", "closeSession",
]);
const QUERY_OPERATIONS = new Set<AgentOperation>(["steerTurn", "interruptTurn"]);
const GLOBAL_OPERATIONS = new Set<AgentOperation>(["listModels", "readRateLimits"]);
const HISTORY_OPERATIONS = new Set<AgentOperation>(["readSession", "forkSession", "renameSession", "deleteSession", "updateSessionMetadata"]);
const DANGEROUS_CODEX_KEYS = new Set([
  "approvalPolicy", "approval_policy", "sandboxPolicy", "sandbox_policy", "sandboxPermissions", "sandbox_permissions",
  "dangerFullAccess", "danger_full_access",
]);
const CODEX_INTERACTION_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "tool/requestUserInput",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);
const INTERACTION_TIMEOUT_MS = 5 * 60_000;
const CLOSED_SESSION_GRANT_MS = 30_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function nativeSessionIdFrom(value: unknown) {
  const payload = record(value);
  const thread = record(payload.thread);
  return stringValue(thread.id) || stringValue(payload.threadId) || stringValue(payload.conversationId);
}

function workspaceFrom(value: unknown) {
  const payload = record(value);
  const thread = record(payload.thread);
  return stringValue(thread.cwd) || stringValue(payload.cwd);
}

function turnIdFrom(value: unknown) {
  const payload = record(value);
  return stringValue(record(payload.turn).id) || stringValue(payload.turnId);
}

function interactionIdFor(requestId: number | string) {
  return String(requestId);
}

export class AgentSessionRegistry {
  private readonly sessions = new Map<string, RegisteredSession>();
  private readonly nativeOwners = new Map<string, string>();
  private readonly interactions = new Map<string, RegisteredInteraction>();
  private readonly knownNativeSessions = new Map<string, string>();
  private readonly closedSessions = new Map<string, ClosedSessionGrant>();

  constructor(private readonly isWorkspaceAuthorized: (cwd: string) => boolean = () => true) {}

  prepareRequest(provider: AgentProvider, operation: AgentOperation, params: JsonObject, context: AgentRequestContext) {
    if ("trustWorkspace" in params) throw new Error("Agent 请求不能自行授予工作区信任。");
    if (provider === "codex") this.rejectDangerousCodexOverrides(params);
    if (operation === "getCapabilities" || GLOBAL_OPERATIONS.has(operation)) return;
    if (operation === "listSkills" && provider === "codex") {
      const workspaces = Array.isArray(params.cwds) ? params.cwds.filter((entry): entry is string => typeof entry === "string") : [];
      if (!workspaces.length || workspaces.length !== (Array.isArray(params.cwds) ? params.cwds.length : 0)) throw new Error("Codex 技能目录无效。");
      const contextCwd = this.requireWorkspace({}, context);
      this.assertWorkspaceAuthorized(contextCwd);
      if (workspaces.some((cwd) => canonicalPath(cwd) !== contextCwd)) throw new Error("Codex 技能目录归属不匹配。");
      return;
    }
    if (operation === "listSessions" || operation === "searchSessions" || this.isWorkspaceScopedOperation(operation)) {
      if ((operation === "listSessions" || operation === "searchSessions") && params.allWorkspaces === true) {
        if (params.cwd || context.canonicalCwd) throw new Error("全部目录历史请求不能绑定单个工作区。");
        return;
      }
      const cwd = this.requireWorkspace(params, context);
      this.assertWorkspaceAuthorized(cwd);
      return;
    }

    if (operation === "startSession") {
      const clientSessionId = this.requireClientSessionId(context);
      if (this.sessions.has(clientSessionId)) throw new Error("客户端会话已登记，不能重复启动。");
      const canonicalCwd = this.requireWorkspace(params, context);
      this.assertWorkspaceAuthorized(canonicalCwd);
      this.sessions.set(clientSessionId, { provider, clientSessionId, canonicalCwd, queryGeneration: 0, queryActive: false });
      return;
    }

    if (operation === "resumeSession") {
      const clientSessionId = this.requireClientSessionId(context);
      const canonicalCwd = this.requireWorkspace(params, context);
      this.assertWorkspaceAuthorized(canonicalCwd);
      const nativeSessionId = this.requireNativeSessionId(params, context);
      const existing = this.sessions.get(clientSessionId);
      if (existing?.queryActive) throw new Error("活动 Query 不能被恢复请求覆盖。");
      if (existing && (existing.provider !== provider || existing.canonicalCwd !== canonicalCwd || (existing.nativeSessionId && existing.nativeSessionId !== nativeSessionId))) {
        throw new Error("客户端会话归属与恢复请求不一致。");
      }
      this.assertNativeOwnerAvailable(provider, nativeSessionId, clientSessionId);
      this.sessions.set(clientSessionId, { provider, clientSessionId, canonicalCwd, nativeSessionId, queryGeneration: existing?.queryGeneration || 0, queryActive: false });
      this.nativeOwners.set(this.nativeKey(provider, nativeSessionId), clientSessionId);
      return;
    }

    if (operation === "deleteSession" && context.sessionId && !this.sessions.has(context.sessionId)) {
      this.requireClosedSessionGrant(provider, params, context);
      return;
    }
    if (!context.sessionId && HISTORY_OPERATIONS.has(operation)) {
      const canonicalCwd = this.requireWorkspace(params, context);
      this.assertWorkspaceAuthorized(canonicalCwd);
      const nativeSessionId = this.requireNativeSessionId(params, context);
      const knownCwd = this.knownNativeSessions.get(this.nativeKey(provider, nativeSessionId));
      if (!knownCwd && operation === "readSession") return;
      if (!knownCwd || knownCwd !== canonicalCwd) throw new Error("原生会话尚未由当前工作区的 Provider 历史登记。");
      return;
    }
    if (operation === "closeSession" && context.sessionId && !this.sessions.has(context.sessionId)) {
      return { skipBackend: true } as const;
    }
    if (!SESSION_OPERATIONS.has(operation)) return;
    const session = this.requireSession(provider, context);
    this.assertContextMatches(session, context);
    this.assertParamsMatch(session, operation, params);
    if (QUERY_OPERATIONS.has(operation) && !session.queryActive) throw new Error("当前会话没有活动 Query。");
  }

  completeRequest(provider: AgentProvider, operation: AgentOperation, params: JsonObject, context: AgentRequestContext, result: unknown) {
    if (operation === "listSessions" || operation === "searchSessions") {
      this.rememberListedSessions(provider, result, typeof params.cwd === "string" ? params.cwd : context.canonicalCwd);
      return;
    }
    const clientSessionId = context.sessionId;
    if (!clientSessionId && HISTORY_OPERATIONS.has(operation)) {
      const canonicalCwd = this.requireWorkspace(params, context);
      const nativeSessionId = this.requireNativeSessionId(params, context);
      if (operation === "readSession") {
        const returnedNativeSessionId = nativeSessionIdFrom(result);
        const returnedCwd = workspaceFrom(result);
        if (returnedNativeSessionId !== nativeSessionId || !returnedCwd || canonicalPath(returnedCwd) !== canonicalCwd) {
          throw new Error("Provider 返回的历史会话归属无效。");
        }
        this.knownNativeSessions.set(this.nativeKey(provider, nativeSessionId), canonicalCwd);
      } else if (operation === "forkSession") {
        const forkedNativeSessionId = nativeSessionIdFrom(result);
        const forkedCwd = workspaceFrom(result);
        if (!forkedNativeSessionId || !forkedCwd || canonicalPath(forkedCwd) !== canonicalCwd) throw new Error("Provider 返回的分支会话归属无效。");
        this.knownNativeSessions.set(this.nativeKey(provider, forkedNativeSessionId), canonicalCwd);
      } else if (operation === "deleteSession") {
        this.knownNativeSessions.delete(this.nativeKey(provider, nativeSessionId));
      }
      return;
    }
    if (!clientSessionId) return;
    if (operation === "deleteSession") this.closedSessions.delete(clientSessionId);
    const session = this.sessions.get(clientSessionId);
    if (!session || session.provider !== provider) return;
    if (operation === "startSession" || operation === "resumeSession") {
      const nativeSessionId = nativeSessionIdFrom(result) || session.nativeSessionId;
      const cwd = workspaceFrom(result);
      if (cwd && canonicalPath(cwd) !== session.canonicalCwd) {
        this.releaseSession(clientSessionId);
        throw new Error("Provider 返回的工作区与会话登记不一致。");
      }
      if (!nativeSessionId) {
        if (operation === "startSession") this.releaseSession(clientSessionId);
        throw new Error("Provider 没有返回可登记的原生会话 ID。");
      }
      this.assertNativeOwnerAvailable(provider, nativeSessionId, clientSessionId);
      session.nativeSessionId = nativeSessionId;
      this.knownNativeSessions.set(this.nativeKey(provider, nativeSessionId), session.canonicalCwd);
      this.nativeOwners.set(this.nativeKey(provider, nativeSessionId), clientSessionId);
    }
    if (operation === "startTurn" || operation === "startReview") {
      if (!turnIdFrom(result)) throw new Error("Provider 没有返回可登记的 Turn ID。");
    }
    if (operation === "forkSession") {
      const forkedNativeSessionId = nativeSessionIdFrom(result);
      const forkedCwd = workspaceFrom(result) || session.canonicalCwd;
      if (!forkedNativeSessionId || canonicalPath(forkedCwd) !== session.canonicalCwd) throw new Error("Provider 返回的分支会话归属无效。");
      this.knownNativeSessions.set(this.nativeKey(provider, forkedNativeSessionId), session.canonicalCwd);
    }
    if (operation === "closeSession") this.releaseSession(clientSessionId, true);
  }

  failRequest(provider: AgentProvider, operation: AgentOperation, context: AgentRequestContext, error: unknown) {
    if (operation !== "startSession" || !context.sessionId) return;
    const payload = provider === "codex" ? decodeCodexRpcError(error) : null;
    const data = record(payload?.data);
    if (data.kind === "requestTimeout" && data.backgroundMayContinue === true) return;
    this.releaseSession(context.sessionId);
  }

  prepareResponse(ref: InteractionRef) {
    if (ref.provider === "claude") return;
    if (ref.requestId === undefined) throw new Error("Codex 交互缺少请求 ID。");
    const key = this.interactionKey(ref.provider, ref.requestId);
    const interaction = this.interactions.get(key);
    if (!interaction || interaction.expiresAt <= Date.now()) {
      if (interaction) this.finishInteraction(key);
      throw new Error("Codex 交互不存在或已过期。");
    }
    if (interaction.status !== "pending") throw new Error("Codex 交互已处理，不能重复响应。");
    if (ref.sessionId !== interaction.sessionId || ref.queryGeneration !== interaction.queryGeneration
      || ref.interactionId !== interaction.interactionId) throw new Error("Codex 交互归属不匹配。");
    interaction.status = "resolving";
  }

  completeResponse(ref: InteractionRef, succeeded: boolean) {
    if (ref.provider === "claude" || ref.requestId === undefined) return;
    const key = this.interactionKey(ref.provider, ref.requestId);
    const interaction = this.interactions.get(key);
    if (!interaction) return;
    if (succeeded) this.finishInteraction(key);
    else interaction.status = "pending";
  }

  observeEvent(event: AgentEventEnvelope) {
    if (event.provider === "claude") {
      const session = event.sessionId ? this.sessions.get(event.sessionId) : undefined;
      if (!session) return event;
      if (event.queryGeneration !== undefined && event.queryGeneration >= session.queryGeneration) session.queryGeneration = event.queryGeneration;
      if (event.type === "claude/turnStarted" || event.type === "claude/ready") session.queryActive = true;
      if (event.type === "claude/queryRestarted" || event.type === "claude/queryClosed" || event.type === "claude/backendExited") {
        session.queryActive = false;
        this.cancelSessionInteractions(session.clientSessionId);
      }
      return { ...event, queryGeneration: session.queryGeneration };
    }
    if (event.type === "client/late-response") {
      this.settleLateCodexStart(event.payload);
      return event;
    }
    const nativeSessionId = nativeSessionIdFrom(event.payload);
    const session = nativeSessionId ? this.sessionByNative(event.provider, nativeSessionId) : undefined;
    if (session && event.type === "turn/started") {
      session.queryGeneration += 1;
      session.queryActive = true;
    } else if (session && (event.type === "turn/completed" || (event.type === "error" && record(event.payload).willRetry !== true))) {
      session.queryActive = false;
      this.cancelSessionInteractions(session.clientSessionId);
    }
    if (session && CODEX_INTERACTION_METHODS.has(event.type) && event.requestId !== undefined && session.queryActive) {
      const interaction: RegisteredInteraction = {
        provider: "codex",
        sessionId: session.clientSessionId,
        nativeSessionId: session.nativeSessionId || nativeSessionId,
        queryGeneration: session.queryGeneration,
        interactionId: interactionIdFor(event.requestId),
        requestId: event.requestId,
        expiresAt: Date.now() + INTERACTION_TIMEOUT_MS,
        status: "pending",
      };
      this.interactions.set(this.interactionKey("codex", event.requestId), interaction);
    }
    if (event.type === "client/server-exited") this.clearProvider("codex");
    if (session && (nativeSessionId || event.queryGeneration !== undefined)) {
      return { ...event, queryGeneration: session.queryGeneration };
    }
    return event;
  }

  clearProvider(provider: AgentProvider) {
    for (const session of [...this.sessions.values()]) if (session.provider === provider) this.releaseSession(session.clientSessionId);
    for (const [sessionId, grant] of this.closedSessions) if (grant.provider === provider) this.closedSessions.delete(sessionId);
    for (const key of this.knownNativeSessions.keys()) if (key.startsWith(`${provider}\u0000`)) this.knownNativeSessions.delete(key);
  }

  rendererSessions(): RendererSessionRegistration[] {
    return [...this.sessions.values()].map((session) => ({
      provider: session.provider,
      context: {
        sessionId: session.clientSessionId,
        canonicalCwd: session.canonicalCwd,
        ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
        queryGeneration: session.queryGeneration,
      },
      queryActive: session.queryActive,
    }));
  }

  clearRendererSessions() {
    for (const sessionId of [...this.sessions.keys()]) this.releaseSession(sessionId);
  }

  private rememberListedSessions(provider: AgentProvider, result: unknown, fallbackCwd?: string) {
    const payload = record(result);
    const data = Array.isArray(payload.data) ? payload.data : [];
    for (const entry of data) {
      const thread = record(record(entry).thread);
      const direct = record(entry);
      const nativeSessionId = stringValue(thread.id) || stringValue(direct.id);
      const cwd = stringValue(thread.cwd) || stringValue(direct.cwd) || stringValue(fallbackCwd);
      if (nativeSessionId && cwd) this.knownNativeSessions.set(this.nativeKey(provider, nativeSessionId), canonicalPath(cwd));
    }
  }

  private settleLateCodexStart(value: unknown) {
    const payload = record(value);
    if (payload.requestMethod !== "thread/start") return;
    const clientSessionId = stringValue(payload.sessionId);
    const session = clientSessionId ? this.sessions.get(clientSessionId) : undefined;
    if (!session || session.provider !== "codex" || session.nativeSessionId) return;
    const response = record(payload.response);
    if (response.error) {
      this.releaseSession(clientSessionId);
      return;
    }
    const nativeSessionId = nativeSessionIdFrom(response.result);
    const returnedCwd = workspaceFrom(response.result);
    if (!nativeSessionId || (returnedCwd && canonicalPath(returnedCwd) !== session.canonicalCwd)) {
      this.releaseSession(clientSessionId);
      return;
    }
    this.assertNativeOwnerAvailable("codex", nativeSessionId, clientSessionId);
    session.nativeSessionId = nativeSessionId;
    this.knownNativeSessions.set(this.nativeKey("codex", nativeSessionId), session.canonicalCwd);
    this.nativeOwners.set(this.nativeKey("codex", nativeSessionId), clientSessionId);
  }

  private rejectDangerousCodexOverrides(value: unknown, depth = 0) {
    if (depth > 16 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry) => this.rejectDangerousCodexOverrides(entry, depth + 1));
      return;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (DANGEROUS_CODEX_KEYS.has(key)) throw new Error(`Codex 安全参数不允许由 Renderer 覆盖：${key}`);
      this.rejectDangerousCodexOverrides(entry, depth + 1);
    }
  }

  private requireClientSessionId(context: AgentRequestContext) {
    if (!context.sessionId) throw new Error("Agent 请求缺少客户端会话 ID。");
    return context.sessionId;
  }

  private requireWorkspace(params: JsonObject, context: AgentRequestContext) {
    const fromParams = stringValue(params.cwd);
    const fromContext = stringValue(context.canonicalCwd);
    if (!fromParams && !fromContext) throw new Error("Agent 请求缺少工作区。");
    const workspace = canonicalPath(fromParams || fromContext);
    if (fromParams && fromContext && workspace !== canonicalPath(fromContext)) throw new Error("Agent 请求工作区归属不匹配。");
    return workspace;
  }

  private assertWorkspaceAuthorized(cwd: string) {
    if (!this.isWorkspaceAuthorized(cwd)) throw new Error("Agent 工作区未经过主进程授权。");
  }

  private isWorkspaceScopedOperation(operation: AgentOperation) {
    return operation === "listPlugins" || operation === "readPlugin" || operation === "installPlugin"
      || operation === "uninstallPlugin" || operation === "updatePlugin" || operation === "addMarketplace"
      || operation === "updateMarketplace" || operation === "removeMarketplace";
  }

  private requireNativeSessionId(params: JsonObject, context: AgentRequestContext) {
    const fromParams = stringValue(params.threadId);
    const fromContext = stringValue(context.nativeSessionId);
    if (!fromParams && !fromContext) throw new Error("Agent 请求缺少原生会话 ID。");
    if (fromParams && fromContext && fromParams !== fromContext) throw new Error("Agent 请求原生会话归属不匹配。");
    return fromParams || fromContext;
  }

  private requireSession(provider: AgentProvider, context: AgentRequestContext) {
    const clientSessionId = this.requireClientSessionId(context);
    const session = this.sessions.get(clientSessionId);
    if (!session || session.provider !== provider) throw new Error("Agent 会话不存在或 Provider 归属不匹配。");
    return session;
  }

  private assertContextMatches(session: RegisteredSession, context: AgentRequestContext) {
    if (context.canonicalCwd && canonicalPath(context.canonicalCwd) !== session.canonicalCwd) throw new Error("Agent 会话工作区归属不匹配。");
    if (context.nativeSessionId && context.nativeSessionId !== session.nativeSessionId) throw new Error("Agent 原生会话归属不匹配。");
    if (context.queryGeneration !== undefined && context.queryGeneration !== session.queryGeneration) throw new Error("Agent Query 代次已失效。");
  }

  private assertParamsMatch(session: RegisteredSession, operation: AgentOperation, params: JsonObject) {
    if (typeof params.cwd === "string" && canonicalPath(params.cwd) !== session.canonicalCwd) throw new Error("Agent 参数工作区归属不匹配。");
    if (operation === "listSkills" && Array.isArray(params.cwds)) {
      const workspaces = params.cwds.filter((entry): entry is string => typeof entry === "string");
      if (workspaces.length !== params.cwds.length || workspaces.some((cwd) => canonicalPath(cwd) !== session.canonicalCwd)) {
        throw new Error("Agent 技能目录归属不匹配。");
      }
    }
    if (typeof params.threadId === "string" && params.threadId !== session.nativeSessionId) throw new Error("Agent 参数原生会话归属不匹配。");
    if (operation !== "listModels" && operation !== "listSkills" && operation !== "readRateLimits" && !session.nativeSessionId) {
      throw new Error("Agent 会话尚未登记原生会话 ID。");
    }
  }

  private assertNativeOwnerAvailable(provider: AgentProvider, nativeSessionId: string, clientSessionId: string) {
    const owner = this.nativeOwners.get(this.nativeKey(provider, nativeSessionId));
    if (owner && owner !== clientSessionId) throw new Error("原生会话已被其他客户端会话占用。");
  }

  private sessionByNative(provider: AgentProvider, nativeSessionId: string) {
    const clientSessionId = this.nativeOwners.get(this.nativeKey(provider, nativeSessionId));
    return clientSessionId ? this.sessions.get(clientSessionId) : undefined;
  }

  private nativeKey(provider: AgentProvider, nativeSessionId: string) {
    return `${provider}\u0000${nativeSessionId}`;
  }

  private interactionKey(provider: AgentProvider, requestId: number | string) {
    return `${provider}\u0000${String(requestId)}`;
  }

  private requireClosedSessionGrant(provider: AgentProvider, params: JsonObject, context: AgentRequestContext) {
    const clientSessionId = this.requireClientSessionId(context);
    const grant = this.closedSessions.get(clientSessionId);
    if (!grant || grant.expiresAt <= Date.now()) {
      this.closedSessions.delete(clientSessionId);
      throw new Error("已关闭会话的删除授权不存在或已过期。");
    }
    const canonicalCwd = this.requireWorkspace(params, context);
    const nativeSessionId = this.requireNativeSessionId(params, context);
    if (grant.provider !== provider || grant.canonicalCwd !== canonicalCwd || grant.nativeSessionId !== nativeSessionId) {
      throw new Error("已关闭会话的删除授权归属不匹配。");
    }
  }

  private finishInteraction(key: string) {
    const interaction = this.interactions.get(key);
    if (interaction) interaction.status = "finished";
    this.interactions.delete(key);
  }

  private cancelSessionInteractions(sessionId: string) {
    for (const [key, interaction] of this.interactions) if (interaction.sessionId === sessionId) this.finishInteraction(key);
  }

  private releaseSession(clientSessionId: string, allowDelete = false) {
    const session = this.sessions.get(clientSessionId);
    if (!session) return;
    if (allowDelete && session.nativeSessionId) {
      this.closedSessions.set(clientSessionId, {
        provider: session.provider,
        canonicalCwd: session.canonicalCwd,
        nativeSessionId: session.nativeSessionId,
        expiresAt: Date.now() + CLOSED_SESSION_GRANT_MS,
      });
    } else {
      this.closedSessions.delete(clientSessionId);
    }
    if (session.nativeSessionId && this.nativeOwners.get(this.nativeKey(session.provider, session.nativeSessionId)) === clientSessionId) {
      this.nativeOwners.delete(this.nativeKey(session.provider, session.nativeSessionId));
    }
    this.cancelSessionInteractions(clientSessionId);
    this.sessions.delete(clientSessionId);
  }
}
