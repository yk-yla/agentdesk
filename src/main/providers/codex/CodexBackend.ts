import type { AgentBackend } from "../../agent/AgentBackend";
import type { AgentCapabilities, AgentEventEnvelope, AgentOperation, AgentRequestContext, InteractionRef } from "../../../shared/agentProtocol";
import { decodeCodexRpcError, encodeCodexRpcError, type JsonObject, type JsonRpcMessage } from "../../../shared/protocol";
import type { CodexTitleGenerator } from "./codexTitleGenerator";
import type { CodexHistoryIndex } from "./codexHistoryIndex";

const METHODS: Record<Exclude<AgentOperation, "getCapabilities" | "closeSession" | "generateSessionTitle">, string> = {
  listModels: "model/list",
  listSkills: "skills/list",
  listSessions: "thread/list",
  searchSessions: "thread/search",
  readSession: "thread/read",
  readSessionPage: "thread/turns/list",
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
const THREAD_BOUND_OPERATIONS = new Set<AgentOperation>([
  "readSession", "readSessionPage", "startSession", "resumeSession", "forkSession", "renameSession", "deleteSession", "updateSessionMetadata", "updateSessionSettings",
  "startTurn", "startReview", "generateSessionTitle", "steerTurn", "interruptTurn", "compactSession", "getGoal", "setGoal", "clearGoal", "closeSession",
]);
// The UI skill listing also reads the default Codex home. User skill folders
// are projected into the isolated home before requests and app-server starts,
// so the active session sees the same resources without sharing writable state.
const DEFAULT_HOME_RESOURCE_OPERATIONS = new Set<AgentOperation>(["listSkills"]);
const CODEX_HISTORY_PAGE_SIZE = 12;

interface MergedHistoryCursor {
  primary: string | null;
  legacy: string | null;
}

function decodeMergedHistoryCursor(value: unknown): MergedHistoryCursor {
  if (typeof value !== "string" || !value) return { primary: null, legacy: null };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && (typeof parsed.primary === "string" || parsed.primary === null || parsed.primary === undefined)
      && (typeof parsed.legacy === "string" || parsed.legacy === null || parsed.legacy === undefined)) {
      return {
        primary: typeof parsed.primary === "string" ? parsed.primary : null,
        legacy: typeof parsed.legacy === "string" ? parsed.legacy : null,
      };
    }
  } catch {
    // Native cursors are opaque strings. Older callers may pass one directly.
  }
  return { primary: value, legacy: value };
}

function nextCursorFrom(value: unknown) {
  const next = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).nextCursor
    : undefined;
  return typeof next === "string" && next ? next : null;
}

function encodeMergedHistoryCursor(value: MergedHistoryCursor) {
  return value.primary || value.legacy ? JSON.stringify(value) : null;
}

function historyThreadRecord(value: Record<string, unknown>, method: string) {
  if (method === "thread/search" && value.thread && typeof value.thread === "object" && !Array.isArray(value.thread)) return value.thread as Record<string, unknown>;
  return value;
}

function historyRecordId(value: Record<string, unknown>, method: string) {
  const thread = historyThreadRecord(value, method);
  return typeof thread.id === "string" ? thread.id : typeof thread.sessionId === "string" ? thread.sessionId : "";
}

function annotateHistoryRecord(value: Record<string, unknown>, method: string, codexHome: "agentdesk" | "default") {
  const thread = historyThreadRecord(value, method);
  const annotatedThread = { ...thread, provider: "codex", codexHome };
  return method === "thread/search" && thread !== value
    ? { ...value, codexHome, thread: annotatedThread }
    : annotatedThread;
}

function historyRecordUpdatedAt(value: Record<string, unknown>, method: string) {
  const thread = historyThreadRecord(value, method);
  return Number(thread.updatedAt || thread.recencyAt || 0);
}

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
  if (operation === "readSession") return { ...prepared, includeTurns: false };
  if (operation === "readSessionPage") return {
    ...prepared,
    limit: Math.min(Math.max(Number(prepared.limit) || CODEX_HISTORY_PAGE_SIZE, 1), CODEX_HISTORY_PAGE_SIZE),
    sortDirection: "desc",
    itemsView: "summary",
  };
  if (operation === "resumeSession") return {
    ...prepared,
    excludeTurns: true,
    initialTurnsPage: { limit: CODEX_HISTORY_PAGE_SIZE, sortDirection: "desc", itemsView: "summary" },
  };
  if (operation === "forkSession") return { ...prepared, excludeTurns: true };
  if ((operation !== "listSessions" && operation !== "searchSessions") || prepared.allWorkspaces !== true) return prepared;
  const { allWorkspaces: _allWorkspaces, ...providerParams } = prepared;
  return providerParams;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeHistoryResult(operation: AgentOperation, value: unknown, params: JsonObject) {
  if (operation !== "resumeSession" && operation !== "readSessionPage") return value;
  const payload = record(value);
  const page = operation === "resumeSession" ? record(payload.initialTurnsPage) : payload;
  const data = Array.isArray(page.data) ? [...page.data].reverse() : [];
  const thread = operation === "resumeSession" ? record(payload.thread) : {};
  const nextCursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
  return {
    ...payload,
    thread: {
      ...thread,
      id: typeof thread.id === "string" ? thread.id : params.threadId,
      ...(typeof thread.cwd === "string" ? {} : typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
      turns: data,
    },
    nextCursor,
    historyHasMoreBefore: Boolean(nextCursor),
  };
}

function shouldRetryResumeWithoutInitialPage(error: unknown) {
  const payload = decodeCodexRpcError(error);
  if (!payload) return false;
  return payload.code === -32602 || /initialTurnsPage|unknown field|invalid params/i.test(payload.message);
}

export interface CodexBackendRuntime {
  request(method: string, params: JsonObject, context: AgentRequestContext, operation: AgentOperation): Promise<unknown>;
  respond(id: number | string, result: JsonObject): Promise<void>;
  subscribe(listener: (message: JsonRpcMessage) => void): () => void;
  close(): Promise<void>;
}

export type CodexRuntimeHome = "agentdesk" | "default";

export interface CodexSessionRuntimeFactory {
  create(input: { sessionId: string; cwd: string; home: CodexRuntimeHome }): CodexBackendRuntime;
}

interface SessionRuntimeEntry {
  runtime: CodexBackendRuntime;
  home: CodexRuntimeHome;
}

export class CodexBackend implements AgentBackend {
  readonly provider = "codex" as const;
  private readonly activeSessions = new Map<string, string>();
  private readonly legacyHistorySessionIds = new Set<string>();
  private readonly legacyClientSessionIds = new Set<string>();
  private readonly eventListeners = new Set<(event: AgentEventEnvelope) => void>();
  private readonly runtimeSubscriptions = new Map<CodexBackendRuntime, () => void>();
  private readonly sessionRuntimes = new Map<string, SessionRuntimeEntry>();

  constructor(
    private readonly runtime: CodexBackendRuntime,
    private readonly titleGenerator?: CodexTitleGenerator,
    private readonly legacyHistoryRuntime?: CodexBackendRuntime,
    private readonly historyIndex?: CodexHistoryIndex,
    private readonly prepare?: () => void | Promise<void>,
    private readonly sessionRuntimeFactory?: CodexSessionRuntimeFactory,
  ) {
    this.subscribeRuntime(this.runtime);
    if (this.legacyHistoryRuntime) this.subscribeRuntime(this.legacyHistoryRuntime);
  }

  async request(operation: AgentOperation, params: JsonObject, context: AgentRequestContext) {
    await this.prepare?.();
    if (operation === "getCapabilities") return this.getCapabilities();
    if (operation === "closeSession") return this.closeSession(context);
    if (operation === "generateSessionTitle") return this.generateSessionTitle(params, context);
    const method = METHODS[operation];
    if (!method) throw new Error(`Codex 不支持该操作：${operation}`);
    const providerParams = providerRequestParams(operation, params);
    if ((operation === "listSessions" || operation === "searchSessions") && (this.legacyHistoryRuntime || (operation === "searchSessions" && this.historyIndex))) {
      return this.requestMergedHistory(method, providerParams, context, operation);
    }
    let selectedRuntime = this.runtimeFor(operation, providerParams, context);
    try {
      let result: unknown;
      try {
        try {
          result = await selectedRuntime.request(method, providerParams, context, operation);
        } catch (error) {
          if (operation !== "resumeSession" || !shouldRetryResumeWithoutInitialPage(error)) throw error;
          const { initialTurnsPage: _initialTurnsPage, ...metadataOnlyParams } = providerParams;
          result = await selectedRuntime.request(method, metadataOnlyParams, context, operation);
        }
      } catch (error) {
        if (!this.shouldRetryResumeOnLegacy(operation, providerParams, context, selectedRuntime, error)) throw error;
        selectedRuntime = this.legacyResumeRuntime(providerParams, context);
        result = await selectedRuntime.request(method, providerParams, context, operation);
      }
      result = normalizeHistoryResult(operation, result, providerParams);
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
      this.rememberRuntimeOwnership(operation, selectedRuntime, providerParams, context, result);
      return result;
    } catch (error) {
      const payload = decodeCodexRpcError(error);
      if (!payload) throw error;
      throw new Error(encodeCodexRpcError({ ...payload, method: operation }));
    }
  }

  respondToInteraction(ref: InteractionRef, result: JsonObject) {
    if (ref.provider !== this.provider || ref.requestId === undefined) throw new Error("Codex 交互引用无效。");
    const runtime = this.sessionRuntimes.get(ref.sessionId)?.runtime
      || (this.legacyHistoryRuntime && this.legacyClientSessionIds.has(ref.sessionId) ? this.legacyHistoryRuntime : this.runtime);
    return runtime.respond(ref.requestId, result);
  }

  subscribeEvents(listener: (event: AgentEventEnvelope) => void) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async getCapabilities() {
    return { ...CAPABILITIES };
  }

  async closeSession(context: AgentRequestContext) {
    if (context.sessionId) this.titleGenerator?.cancel(context.sessionId);
    try {
      if (context.nativeSessionId) {
        await this.runtimeFor("closeSession", {}, context).request("thread/unsubscribe", { threadId: context.nativeSessionId }, context, "closeSession");
      }
    } finally {
      if (context.sessionId) {
        this.activeSessions.delete(context.sessionId);
        this.legacyClientSessionIds.delete(context.sessionId);
        await this.releaseSessionRuntime(context.sessionId);
      }
    }
  }

  async close() {
    const sessionRuntimes = [...this.sessionRuntimes.keys()].map((sessionId) => this.releaseSessionRuntime(sessionId));
    await Promise.all([this.titleGenerator?.close() || Promise.resolve(), this.runtime.close(), this.legacyHistoryRuntime?.close() || Promise.resolve(), ...sessionRuntimes]);
    this.runtimeSubscriptions.forEach((unsubscribe) => unsubscribe());
    this.runtimeSubscriptions.clear();
    this.activeSessions.clear();
    this.legacyClientSessionIds.clear();
  }

  private async generateSessionTitle(params: JsonObject, context: AgentRequestContext) {
    const threadId = typeof params.threadId === "string" ? params.threadId : context.nativeSessionId;
    const cwd = typeof params.cwd === "string" ? params.cwd : context.canonicalCwd;
    const conversation = typeof params.conversation === "string" ? params.conversation : "";
    if (!threadId || !cwd) throw new Error("Codex 标题请求缺少会话归属。");

    const runtime = this.runtimeFor("generateSessionTitle", { threadId, cwd }, context);
    const read = await runtime.request("thread/read", { threadId, includeTurns: false }, context, "generateSessionTitle");
    const thread = read && typeof read === "object" && !Array.isArray(read) && "thread" in read
      ? (read as { thread?: unknown }).thread
      : undefined;
    const nativeName = thread && typeof thread === "object" && !Array.isArray(thread) && typeof (thread as { name?: unknown }).name === "string"
      ? (thread as { name: string }).name.trim().slice(0, 200)
      : "";
    if (nativeName && nativeName !== "新会话") return { title: nativeName, source: "native" };
    if (!this.titleGenerator || !conversation.trim()) return { title: "", source: "fallback" };

    const generated = await this.titleGenerator.generate({ sessionId: context.sessionId || threadId, cwd, conversation });
    const reread = await runtime.request("thread/read", { threadId, includeTurns: false }, context, "generateSessionTitle");
    const latestThread = reread && typeof reread === "object" && !Array.isArray(reread) && "thread" in reread
      ? (reread as { thread?: unknown }).thread
      : undefined;
    const latestName = latestThread && typeof latestThread === "object" && !Array.isArray(latestThread) && typeof (latestThread as { name?: unknown }).name === "string"
      ? (latestThread as { name: string }).name.trim().slice(0, 200)
      : "";
    if (latestName && latestName !== "新会话") return { title: latestName, source: "native" };
    await runtime.request("thread/name/set", { threadId, name: generated }, context, "generateSessionTitle");
    return { title: generated, source: "generated" };
  }

  private runtimeFor(operation: AgentOperation, params: JsonObject, context: AgentRequestContext) {
    if (this.sessionRuntimeFactory && context.sessionId && THREAD_BOUND_OPERATIONS.has(operation)) {
      const nativeSessionId = typeof params.threadId === "string" ? params.threadId : context.nativeSessionId;
      const home: CodexRuntimeHome = this.legacyClientSessionIds.has(context.sessionId) || (nativeSessionId ? this.legacyHistorySessionIds.has(nativeSessionId) : false)
        ? "default" : "agentdesk";
      return this.sessionRuntime(context.sessionId, context.canonicalCwd || (typeof params.cwd === "string" ? params.cwd : ""), home);
    }
    if (this.legacyHistoryRuntime && DEFAULT_HOME_RESOURCE_OPERATIONS.has(operation)) return this.legacyHistoryRuntime;
    if (!this.legacyHistoryRuntime || !THREAD_BOUND_OPERATIONS.has(operation)) return this.runtime;
    if (context.sessionId && this.legacyClientSessionIds.has(context.sessionId)) return this.legacyHistoryRuntime;
    const nativeSessionId = typeof params.threadId === "string" ? params.threadId : context.nativeSessionId;
    return nativeSessionId && this.legacyHistorySessionIds.has(nativeSessionId) ? this.legacyHistoryRuntime : this.runtime;
  }

  private shouldRetryResumeOnLegacy(
    operation: AgentOperation,
    params: JsonObject,
    context: AgentRequestContext,
    selectedRuntime: CodexBackendRuntime,
    error: unknown,
  ) {
    if (operation !== "resumeSession" || !this.legacyHistoryRuntime) return false;
    const nativeSessionId = typeof params.threadId === "string" ? params.threadId : context.nativeSessionId;
    if (!nativeSessionId) return false;
    const selectedSessionRuntime = context.sessionId ? this.sessionRuntimes.get(context.sessionId) : undefined;
    const selectedPrimary = selectedRuntime === this.runtime || (selectedSessionRuntime?.runtime === selectedRuntime && selectedSessionRuntime.home === "agentdesk");
    if (!selectedPrimary) return false;
    const payload = decodeCodexRpcError(error);
    return payload?.code === -32600 && /(?:no rollout found|thread not found)/i.test(payload.message);
  }

  private rememberRuntimeOwnership(operation: AgentOperation, runtime: CodexBackendRuntime, params: JsonObject, context: AgentRequestContext, result: unknown) {
    if (!this.legacyHistoryRuntime || !THREAD_BOUND_OPERATIONS.has(operation)) return;
    const payload = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
    const thread = payload.thread && typeof payload.thread === "object" && !Array.isArray(payload.thread) ? payload.thread as Record<string, unknown> : {};
    const nativeSessionId = typeof thread.id === "string"
      ? thread.id
      : typeof payload.threadId === "string"
        ? payload.threadId
        : typeof params.threadId === "string" ? params.threadId : context.nativeSessionId;
    const sessionRuntime = context.sessionId ? this.sessionRuntimes.get(context.sessionId) : undefined;
    if (runtime === this.legacyHistoryRuntime || (sessionRuntime?.runtime === runtime && sessionRuntime.home === "default")) {
      if (nativeSessionId) this.legacyHistorySessionIds.add(nativeSessionId);
      if (context.sessionId) this.legacyClientSessionIds.add(context.sessionId);
    } else if (context.sessionId) {
      this.legacyClientSessionIds.delete(context.sessionId);
    }
  }

  private legacyResumeRuntime(params: JsonObject, context: AgentRequestContext) {
    if (!this.legacyHistoryRuntime) return this.runtime;
    if (!this.sessionRuntimeFactory || !context.sessionId) return this.legacyHistoryRuntime;
    void this.releaseSessionRuntime(context.sessionId);
    return this.sessionRuntime(
      context.sessionId,
      context.canonicalCwd || (typeof params.cwd === "string" ? params.cwd : ""),
      "default",
    );
  }

  private sessionRuntime(sessionId: string, cwd: string, home: CodexRuntimeHome) {
    const existing = this.sessionRuntimes.get(sessionId);
    if (existing?.home === home) return existing.runtime;
    if (existing) void this.releaseSessionRuntime(sessionId);
    const runtime = this.sessionRuntimeFactory?.create({ sessionId, cwd, home });
    if (!runtime) return home === "default" && this.legacyHistoryRuntime ? this.legacyHistoryRuntime : this.runtime;
    this.sessionRuntimes.set(sessionId, { runtime, home });
    this.subscribeRuntime(runtime, sessionId);
    return runtime;
  }

  private subscribeRuntime(runtime: CodexBackendRuntime, sessionId?: string) {
    if (this.runtimeSubscriptions.has(runtime)) return;
    const unsubscribe = runtime.subscribe((message) => {
      if (!sessionId && this.sessionRuntimeFactory && message.method === "client/server-exited") return;
      const event: AgentEventEnvelope = {
        provider: this.provider,
        ...(sessionId ? { sessionId } : {}),
        requestId: message.id,
        receivedAt: Date.now(),
        type: message.method || "codex/unknown",
        payload: message.params ?? message.result ?? message.error ?? {},
      };
      this.eventListeners.forEach((listener) => listener(event));
      if (sessionId && message.method === "client/server-exited" && this.sessionRuntimes.get(sessionId)?.runtime === runtime) {
        void this.releaseSessionRuntime(sessionId);
      }
    });
    this.runtimeSubscriptions.set(runtime, unsubscribe);
  }

  private async releaseSessionRuntime(sessionId: string) {
    const entry = this.sessionRuntimes.get(sessionId);
    if (!entry) return;
    this.sessionRuntimes.delete(sessionId);
    this.runtimeSubscriptions.get(entry.runtime)?.();
    this.runtimeSubscriptions.delete(entry.runtime);
    await entry.runtime.close();
  }

  private async requestMergedHistory(method: string, params: JsonObject, context: AgentRequestContext, operation: AgentOperation) {
    const cursor = decodeMergedHistoryCursor(params.cursor);
    const requestParams = (value: string | null): JsonObject => ({ ...params, cursor: value });
    const localPromise = operation === "searchSessions" && this.historyIndex
      ? this.historyIndex.search(params).catch(() => ({ data: [], nextCursor: null }))
      : Promise.resolve(undefined);
    const requests = [this.runtime.request(method, this.legacyHistoryRuntime ? requestParams(cursor.primary) : params, context, operation)];
    if (this.legacyHistoryRuntime) requests.push(this.legacyHistoryRuntime.request(method, requestParams(cursor.legacy), context, operation));
    const results = await Promise.allSettled(requests);
    const local = await localPromise;
    const localData = Array.isArray(local?.data) ? local.data : [];
    const successful = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!successful.length) {
      const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 100);
      if (localData.length) return { data: localData.slice(0, limit), nextCursor: null };
      const failed = results.find((result) => result.status === "rejected");
      throw failed && failed.status === "rejected" ? failed.reason : new Error("Codex 历史读取失败。");
    }
    const entries = new Map<string, Record<string, unknown>>();
    for (const [runtimeIndex, value] of results.entries()) {
      if (value.status !== "fulfilled") continue;
      const codexHome = runtimeIndex === 1 ? "default" : "agentdesk";
      const payload = value.value;
      const data = payload && typeof payload === "object" && !Array.isArray(payload) && Array.isArray((payload as Record<string, unknown>).data)
        ? (payload as Record<string, unknown>).data as unknown[] : [];
      this.historyIndex?.observeThreads({ data });
      for (const item of data) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const id = historyRecordId(record, method);
        if (id) {
          const annotated = annotateHistoryRecord(record, method, codexHome);
          entries.set(id, annotated);
          if (codexHome === "default") this.legacyHistorySessionIds.add(id);
        }
      }
    }
    if (operation === "searchSessions" && typeof params.searchTerm === "string" && params.searchTerm.trim()) {
      for (const item of localData) {
        const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
        const thread = record.thread && typeof record.thread === "object" && !Array.isArray(record.thread)
          ? record.thread as Record<string, unknown>
          : record;
        const id = typeof thread.id === "string" ? thread.id : typeof thread.sessionId === "string" ? thread.sessionId : "";
        if (id && !entries.has(id)) entries.set(id, record);
      }
    }
    const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 100);
    const data = [...entries.values()]
      .sort((left, right) => historyRecordUpdatedAt(right, method) - historyRecordUpdatedAt(left, method))
      .slice(0, limit);
    const legacyResult = results[1];
    if (this.legacyHistoryRuntime && legacyResult?.status === "fulfilled" && legacyResult.value && typeof legacyResult.value === "object" && !Array.isArray(legacyResult.value)) {
      const legacyData = Array.isArray((legacyResult.value as Record<string, unknown>).data) ? (legacyResult.value as Record<string, unknown>).data as unknown[] : [];
      for (const item of legacyData) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const id = historyRecordId(record, method);
        if (id) this.legacyHistorySessionIds.add(id);
      }
    }
    const primaryResult = results[0];
    if (!this.legacyHistoryRuntime) {
      return { data, nextCursor: primaryResult.status === "fulfilled" ? nextCursorFrom(primaryResult.value) : null };
    }
    const next = {
      primary: primaryResult.status === "fulfilled" ? nextCursorFrom(primaryResult.value) : cursor.primary,
      legacy: legacyResult?.status === "fulfilled" ? nextCursorFrom(legacyResult.value) : cursor.legacy,
    } satisfies MergedHistoryCursor;
    return { data, nextCursor: encodeMergedHistoryCursor(next) };
  }
}
