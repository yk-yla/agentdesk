import type { AgentBackend } from "../../agent/AgentBackend";
import type { AgentCapabilities, AgentEventEnvelope, AgentOperation, AgentRequestContext, InteractionRef } from "../../../shared/agentProtocol";
import { decodeCodexRpcError, encodeCodexRpcError, type JsonObject, type JsonRpcMessage } from "../../../shared/protocol";
import type { CodexTitleGenerator } from "./codexTitleGenerator";

const METHODS: Record<Exclude<AgentOperation, "getCapabilities" | "closeSession" | "generateSessionTitle">, string> = {
  listModels: "model/list",
  listSkills: "skills/list",
  listSessions: "thread/list",
  searchSessions: "thread/search",
  readSession: "thread/read",
  startSession: "thread/start",
  resumeSession: "thread/resume",
  forkSession: "thread/fork",
  renameSession: "thread/name/set",
  deleteSession: "thread/delete",
  updateSessionMetadata: "thread/metadata/update",
  updateSessionSettings: "thread/settings/update",
  startTurn: "turn/start",
  startReview: "review/start",
  steerTurn: "turn/steer",
  interruptTurn: "turn/interrupt",
  compactSession: "thread/compact/start",
  readRateLimits: "account/rateLimits/read",
  listMcpServers: "mcpServerStatus/list",
  getGoal: "thread/goal/get",
  setGoal: "thread/goal/set",
  clearGoal: "thread/goal/clear",
};

const CAPABILITIES: AgentCapabilities = {
  models: "supported", effort: "supported", images: "supported", history: "supported", historySearch: "supported",
  rename: "supported", pin: "supported", favorite: "supported", fork: "supported", delete: "supported", interrupt: "supported",
  steer: "supported", compact: "supported", review: "supported", skills: "supported", commands: "supported", mcp: "supported",
  pluginsLoad: "supported", goals: "supported", plans: "supported", subagents: "supported", contextUsage: "supported",
};

const THREAD_CONFIGURATION_OPERATIONS = new Set<AgentOperation>(["startSession", "resumeSession", "forkSession"]);

function forcedExecutionParams(operation: AgentOperation, params: JsonObject): JsonObject {
  if (THREAD_CONFIGURATION_OPERATIONS.has(operation)) {
    return { ...params, approvalPolicy: "never", sandbox: "danger-full-access" };
  }
  if (operation === "startTurn") {
    return { ...params, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
  }
  return params;
}

function providerRequestParams(operation: AgentOperation, params: JsonObject) {
  const prepared = forcedExecutionParams(operation, params);
  if ((operation !== "listSessions" && operation !== "searchSessions") || prepared.allWorkspaces !== true) return prepared;
  const { allWorkspaces: _allWorkspaces, ...providerParams } = prepared;
  return providerParams;
}

export interface CodexBackendRuntime {
  request(method: string, params: JsonObject, context: AgentRequestContext, operation: AgentOperation): Promise<unknown>;
  respond(id: number | string, result: JsonObject): Promise<void>;
  subscribe(listener: (message: JsonRpcMessage) => void): () => void;
  close(): Promise<void>;
  closeForHandoff?(): Promise<void>;
}

export class CodexBackend implements AgentBackend {
  readonly provider = "codex" as const;
  private readonly activeSessions = new Map<string, string>();

  constructor(
    private readonly runtime: CodexBackendRuntime,
    private readonly titleGenerator?: CodexTitleGenerator,
  ) {}

  async request(operation: AgentOperation, params: JsonObject, context: AgentRequestContext) {
    if (operation === "getCapabilities") return this.getCapabilities();
    if (operation === "closeSession") return this.closeSession(context);
    if (operation === "generateSessionTitle") return this.generateSessionTitle(params, context);
    const method = METHODS[operation];
    if (!method) throw new Error(`Codex 不支持该操作：${operation}`);
    const providerParams = providerRequestParams(operation, params);
    try {
      const result = await this.runtime.request(method, providerParams, context, operation);
      if ((operation === "startSession" || operation === "resumeSession") && context.sessionId) {
        const payload = result && typeof result === "object" && !Array.isArray(result)
          ? result as { thread?: unknown; threadId?: unknown }
          : {};
        const thread = payload.thread && typeof payload.thread === "object" && !Array.isArray(payload.thread)
          ? payload.thread as { id?: unknown }
          : {};
        const nativeSessionId = typeof thread.id === "string"
          ? thread.id
          : typeof payload.threadId === "string" ? payload.threadId : context.nativeSessionId;
        if (nativeSessionId) this.activeSessions.set(context.sessionId, nativeSessionId);
      }
      return result;
    } catch (error) {
      const payload = decodeCodexRpcError(error);
      if (!payload) throw error;
      throw new Error(encodeCodexRpcError({ ...payload, method: operation }));
    }
  }

  respondToInteraction(ref: InteractionRef, result: JsonObject) {
    if (ref.provider !== this.provider || ref.requestId === undefined) throw new Error("Codex 交互引用无效。");
    return this.runtime.respond(ref.requestId, result);
  }

  subscribeEvents(listener: (event: AgentEventEnvelope) => void) {
    return this.runtime.subscribe((message) => listener({
      provider: this.provider,
      requestId: message.id,
      receivedAt: Date.now(),
      type: message.method || "codex/unknown",
      payload: message.params ?? message.result ?? message.error ?? {},
    }));
  }

  async getCapabilities() {
    return { ...CAPABILITIES };
  }

  async closeSession(context: AgentRequestContext) {
    if (context.sessionId) this.titleGenerator?.cancel(context.sessionId);
    if (context.nativeSessionId) {
      await this.runtime.request("thread/unsubscribe", { threadId: context.nativeSessionId }, context, "closeSession");
    }
    if (context.sessionId) this.activeSessions.delete(context.sessionId);
  }

  async prepareTerminalSession(context: AgentRequestContext) {
    await (this.runtime.closeForHandoff || this.runtime.close).call(this.runtime);
    this.activeSessions.clear();
  }

  async close() {
    await Promise.all([this.titleGenerator?.close() || Promise.resolve(), this.runtime.close()]);
    this.activeSessions.clear();
  }

  private async generateSessionTitle(params: JsonObject, context: AgentRequestContext) {
    const threadId = typeof params.threadId === "string" ? params.threadId : context.nativeSessionId;
    const cwd = typeof params.cwd === "string" ? params.cwd : context.canonicalCwd;
    const conversation = typeof params.conversation === "string" ? params.conversation : "";
    if (!threadId || !cwd) throw new Error("Codex 标题请求缺少会话归属。");

    const read = await this.runtime.request("thread/read", { threadId, includeTurns: false }, context, "generateSessionTitle");
    const thread = read && typeof read === "object" && !Array.isArray(read) && "thread" in read
      ? (read as { thread?: unknown }).thread
      : undefined;
    const nativeName = thread && typeof thread === "object" && !Array.isArray(thread) && typeof (thread as { name?: unknown }).name === "string"
      ? (thread as { name: string }).name.trim().slice(0, 200)
      : "";
    if (nativeName && nativeName !== "新会话") return { title: nativeName, source: "native" };
    if (!this.titleGenerator || !conversation.trim()) return { title: "", source: "fallback" };

    const generated = await this.titleGenerator.generate({ sessionId: context.sessionId || threadId, cwd, conversation });
    const reread = await this.runtime.request("thread/read", { threadId, includeTurns: false }, context, "generateSessionTitle");
    const latestThread = reread && typeof reread === "object" && !Array.isArray(reread) && "thread" in reread
      ? (reread as { thread?: unknown }).thread
      : undefined;
    const latestName = latestThread && typeof latestThread === "object" && !Array.isArray(latestThread) && typeof (latestThread as { name?: unknown }).name === "string"
      ? (latestThread as { name: string }).name.trim().slice(0, 200)
      : "";
    if (latestName && latestName !== "新会话") return { title: latestName, source: "native" };
    await this.runtime.request("thread/name/set", { threadId, name: generated }, context, "generateSessionTitle");
    return { title: generated, source: "generated" };
  }

}
