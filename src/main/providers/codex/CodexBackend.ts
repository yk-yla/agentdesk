import type { AgentBackend } from "../../agent/AgentBackend";
import type { AgentCapabilities, AgentEventEnvelope, AgentOperation, AgentRequestContext, InteractionRef } from "../../../shared/agentProtocol";
import { decodeCodexRpcError, encodeCodexRpcError, type JsonObject, type JsonRpcMessage } from "../../../shared/protocol";

const METHODS: Record<Exclude<AgentOperation, "getCapabilities" | "closeSession">, string> = {
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
  listPlugins: "plugin/list",
  readPlugin: "plugin/read",
  installPlugin: "plugin/install",
  uninstallPlugin: "plugin/uninstall",
  updatePlugin: "plugin/update",
  addMarketplace: "marketplace/add",
  updateMarketplace: "marketplace/upgrade",
  removeMarketplace: "marketplace/remove",
};

const CAPABILITIES: AgentCapabilities = {
  models: "supported", effort: "supported", images: "supported", history: "supported", historySearch: "supported",
  rename: "supported", pin: "supported", favorite: "supported", fork: "supported", delete: "supported", interrupt: "supported",
  steer: "supported", compact: "supported", review: "supported", skills: "supported", commands: "supported", mcp: "supported",
  pluginsLoad: "supported", pluginMarketplace: "supported", goals: "supported", plans: "supported", subagents: "supported", contextUsage: "supported",
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
}

export class CodexBackend implements AgentBackend {
  readonly provider = "codex" as const;

  constructor(private readonly runtime: CodexBackendRuntime) {}

  async request(operation: AgentOperation, params: JsonObject, context: AgentRequestContext) {
    if (operation === "getCapabilities") return this.getCapabilities();
    if (operation === "closeSession") return this.closeSession(context);
    const method = METHODS[operation];
    if (!method) throw new Error(`Codex 不支持该操作：${operation}`);
    const providerParams = providerRequestParams(operation, params);
    try {
      return await this.runtime.request(method, providerParams, context, operation);
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

  async closeSession(_context: AgentRequestContext) {
    // Codex app-server 是多会话共享进程；关闭空闲 Tab 只释放渲染层状态。
  }

  close() {
    return this.runtime.close();
  }
}
