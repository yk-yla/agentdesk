import { randomUUID } from "node:crypto";
import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackend } from "../../agent/AgentBackend";
import type { AgentCapabilities, AgentEventEnvelope, AgentOperation, AgentRequestContext, InteractionRef } from "../../../shared/agentProtocol";
import type { JsonObject } from "../../../shared/protocol";
import { canonicalWorkspace } from "../../localPathPolicy";
import { searchSnippet, sessionSearchText } from "./claudeHistorySearch";

const CAPABILITIES: AgentCapabilities = {
  models: "unsupported", effort: "unsupported", images: "unsupported", history: "supported",
  historySearch: "supported", rename: "supported", pin: "unsupported", favorite: "supported", fork: "supported",
  delete: "supported", interrupt: "unsupported", steer: "unsupported", compact: "unsupported", review: "unsupported",
  skills: "unsupported", commands: "unsupported", mcp: "unsupported", pluginsLoad: "unsupported",
  goals: "unsupported", plans: "unsupported", subagents: "unsupported", contextUsage: "unsupported",
};

// The SDK applies offset from the beginning of the transcript.  We keep the
// page size bounded for responsiveness, but never cap the total history.
export const DEFAULT_CLAUDE_HISTORY_PAGE_SIZE = 200;
const MAX_CLAUDE_HISTORY_PAGE_SIZE = 500;

export interface ClaudeHistoryPage<T> {
  messages: T[];
  offset: number;
  total: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export function paginateClaudeHistoryMessages<T>(messages: T[], requestedOffset?: number, requestedLimit = DEFAULT_CLAUDE_HISTORY_PAGE_SIZE): ClaudeHistoryPage<T> {
  const limit = Math.min(Math.max(Math.floor(requestedLimit) || DEFAULT_CLAUDE_HISTORY_PAGE_SIZE, 1), MAX_CLAUDE_HISTORY_PAGE_SIZE);
  const total = messages.length;
  const latestOffset = Math.max(0, total - limit);
  const offset = typeof requestedOffset === "number" && Number.isSafeInteger(requestedOffset)
    ? Math.min(Math.max(0, requestedOffset), total)
    : latestOffset;
  const page = messages.slice(offset, offset + limit);
  return {
    messages: page,
    offset,
    total,
    hasMoreBefore: offset > 0,
    hasMoreAfter: offset + page.length < total,
  };
}

interface ClaudeSession {
  clientSessionId: string;
  nativeSessionId: string;
  cwd: string;
  queryGeneration: number;
}

function sessionTitleFromInfo(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const info = value as Record<string, unknown>;
  return (typeof info.customTitle === "string" && info.customTitle.trim()
    ? info.customTitle
    : typeof info.summary === "string" && info.summary.trim()
      ? info.summary
      : typeof info.firstPrompt === "string" ? info.firstPrompt : "").trim().slice(0, 200);
}

function sessionSummary(session: SDKSessionInfo) {
  return {
    id: session.sessionId,
    cwd: session.cwd || "",
    name: session.customTitle || session.summary || session.firstPrompt || "",
    updatedAt: session.lastModified ? Math.round(session.lastModified / 1000) : 0,
    provider: "claude" as const,
  };
}

/**
 * Simplified Claude Backend — only provides history browsing and session
 * identity registration. Claude Code interaction happens in the configured
 * external terminal, so AgentDesk keeps these sessions read-only.
 */
export class ClaudeBackend implements AgentBackend {
  readonly provider = "claude" as const;
  private readonly listeners = new Set<(event: AgentEventEnvelope) => void>();
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly knownNativeSessions = new Set<string>();

  async request(operation: AgentOperation, params: JsonObject, context: AgentRequestContext) {
    if (operation === "getCapabilities") return this.getCapabilities();
    if (operation === "startSession") return this.startSession(params, context);
    if (operation === "resumeSession") return this.resumeSession(params, context);
    if (operation === "closeSession") return this.closeSession(context);
    if (operation === "listSessions") return this.listSessionsOp(params, context);
    if (operation === "searchSessions") return this.searchSessions(params, context);
    if (operation === "readSession") return this.readSession(params, context);
    if (operation === "generateSessionTitle") return this.generateSessionTitle(params, context);
    if (operation === "forkSession") return this.forkSessionOp(params, context);
    if (operation === "renameSession") return this.renameSessionOp(params, context);
    if (operation === "deleteSession") return this.deleteSessionOp(params, context);
    throw new Error(`Claude Code 暂不支持该操作：${operation}`);
  }

  async respondToInteraction(_ref: InteractionRef, _result: JsonObject): Promise<void> {
    throw new Error("Claude 外部终端会话不支持在 AgentDesk 中响应交互。");
  }

  subscribeEvents(listener: (event: AgentEventEnvelope) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getCapabilities() {
    return { ...CAPABILITIES };
  }

  async closeSession(context: AgentRequestContext) {
    const session = this.sessionFor(context);
    if (session) this.sessions.delete(session.clientSessionId);
  }

  async close() {
    this.sessions.clear();
  }

  async shutdown() {
    this.sessions.clear();
  }

  private startSession(params: JsonObject, context: AgentRequestContext) {
    const clientSessionId = context.sessionId;
    const cwdValue = typeof params.cwd === "string" ? params.cwd : context.canonicalCwd;
    if (!clientSessionId || !cwdValue) throw new Error("Claude 会话缺少客户端会话或工作区。");
    const cwd = canonicalWorkspace(cwdValue);
    if (this.sessions.has(clientSessionId)) throw new Error("Claude 客户端会话已存在，不能重复启动。");
    const nativeSessionId = randomUUID();
    const session: ClaudeSession = { clientSessionId, nativeSessionId, cwd, queryGeneration: 0 };
    this.sessions.set(clientSessionId, session);
    this.rememberNativeSession(cwd, nativeSessionId);
    return { thread: { id: nativeSessionId, cwd, name: "新会话" }, model: "", reasoningEffort: "" };
  }

  private async resumeSession(params: JsonObject, context: AgentRequestContext) {
    const clientSessionId = context.sessionId;
    const { cwd, nativeSessionId } = this.sessionIdentity(params, context);
    if (!clientSessionId) throw new Error("Claude 恢复缺少客户端会话。");
    await this.assertKnownNativeSession(cwd, nativeSessionId);
    const existing = this.sessions.get(clientSessionId);
    if (existing && (existing.cwd !== cwd || existing.nativeSessionId !== nativeSessionId)) throw new Error("Claude 客户端会话归属与恢复请求不一致。");
    const session: ClaudeSession = existing || { clientSessionId, nativeSessionId, cwd, queryGeneration: 0 };
    session.nativeSessionId = nativeSessionId;
    session.cwd = cwd;
    this.sessions.set(clientSessionId, session);
    return { thread: { id: nativeSessionId, cwd }, model: "", reasoningEffort: "", queryGeneration: session.queryGeneration };
  }

  private async listSessionsOp(params: JsonObject, context: AgentRequestContext) {
    const allWorkspaces = params.allWorkspaces === true;
    const cwd = allWorkspaces ? undefined : canonicalWorkspace(typeof params.cwd === "string" ? params.cwd : context.canonicalCwd || "");
    if (!allWorkspaces && !cwd) throw new Error("Claude 历史缺少工作区。");
    const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 100);
    const cursor = typeof params.cursor === "string" && params.cursor ? Number(params.cursor) : 0;
    const offset = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
    const result = await listSessions({ ...(cwd ? { dir: cwd } : {}), limit: limit + 1, offset, includeWorktrees: false });
    const sessions = Array.isArray(result) ? result : [];
    const hasMore = sessions.length > limit;
    const data = sessions.slice(0, limit).map(sessionSummary);
    this.rememberHistoryEntries(data, cwd || "");
    return { data, nextCursor: hasMore ? String(offset + limit) : null };
  }

  private async searchSessions(params: JsonObject, context: AgentRequestContext) {
    const allWorkspaces = params.allWorkspaces === true;
    const cwd = allWorkspaces ? undefined : canonicalWorkspace(typeof params.cwd === "string" ? params.cwd : context.canonicalCwd || "");
    const searchTerm = typeof params.searchTerm === "string" ? params.searchTerm.trim() : "";
    if ((!allWorkspaces && !cwd) || !searchTerm) return { data: [], nextCursor: null };
    const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 100);
    const allSessions: SDKSessionInfo[] = [];
    let searchOffset = 0;
    const PAGE_SIZE = 500;
    while (true) {
      const page = await listSessions({ ...(cwd ? { dir: cwd } : {}), limit: PAGE_SIZE, offset: searchOffset, includeWorktrees: false });
      const items = Array.isArray(page) ? page : [];
      allSessions.push(...items);
      if (items.length < PAGE_SIZE) break;
      searchOffset += PAGE_SIZE;
    }
    const sessions = allSessions;
    const results: Array<{ session: SDKSessionInfo; snippet: string }> = [];
    const needle = searchTerm.toLowerCase();
    for (const session of sessions) {
      if (results.length >= limit) break;
      const text = await sessionSearchText(
        { sessionId: session.sessionId, customTitle: session.customTitle, summary: session.summary, firstPrompt: session.firstPrompt },
        cwd,
        (sessionId, options) => getSessionMessages(sessionId, options),
      );
      if (text.toLowerCase().includes(needle)) {
        results.push({ session, snippet: searchSnippet(text, searchTerm) });
      }
    }
    const data = results.map((entry) => ({ ...sessionSummary(entry.session), snippet: entry.snippet }));
    this.rememberHistoryEntries(data, cwd || "");
    return { data, nextCursor: null };
  }

  private async readSession(params: JsonObject, context: AgentRequestContext) {
    const { cwd, nativeSessionId } = this.sessionIdentity(params, context);
    await this.assertKnownNativeSession(cwd, nativeSessionId);
    const info = await getSessionInfo(nativeSessionId, { dir: cwd });
    const allMessages = await getSessionMessages(nativeSessionId, { dir: cwd });
    const page = paginateClaudeHistoryMessages(
      Array.isArray(allMessages) ? allMessages : [],
      typeof params.messageOffset === "number" ? params.messageOffset : undefined,
      typeof params.messageLimit === "number" ? params.messageLimit : DEFAULT_CLAUDE_HISTORY_PAGE_SIZE,
    );
    const model = info && typeof info === "object" && "model" in info && typeof info.model === "string" ? info.model : "";
    return { thread: {
      ...(info || {}),
      id: nativeSessionId,
      cwd,
      ...(model ? { model } : {}),
      messages: page.messages,
      messageOffset: page.offset,
      messageTotal: page.total,
      messageHasMoreBefore: page.hasMoreBefore,
      messageHasMoreAfter: page.hasMoreAfter,
    } };
  }

  private async generateSessionTitle(params: JsonObject, context: AgentRequestContext) {
    const { cwd, nativeSessionId } = this.sessionIdentity(params, context);
    await this.assertKnownNativeSession(cwd, nativeSessionId);
    const info = await getSessionInfo(nativeSessionId, { dir: cwd });
    const title = sessionTitleFromInfo(info);
    return title ? { title, source: "native" } : { title: "", source: "fallback" };
  }

  private async forkSessionOp(params: JsonObject, context: AgentRequestContext) {
    const { cwd, nativeSessionId } = this.sessionIdentity(params, context);
    await this.assertKnownNativeSession(cwd, nativeSessionId);
    const result = await forkSession(nativeSessionId, { dir: cwd });
    const forkedId = result && typeof result === "object" && "sessionId" in result && typeof result.sessionId === "string" ? result.sessionId : "";
    if (!forkedId) throw new Error("Claude 分支没有返回会话 ID。");
    this.rememberNativeSession(cwd, forkedId);
    return { thread: { id: forkedId, cwd, name: typeof params.title === "string" ? params.title : "分支会话" } };
  }

  private async renameSessionOp(params: JsonObject, context: AgentRequestContext) {
    const { cwd, nativeSessionId } = this.sessionIdentity(params, context);
    await this.assertKnownNativeSession(cwd, nativeSessionId);
    const title = typeof params.name === "string" ? params.name.trim() : "";
    if (!title) throw new Error("Claude 会话名称不能为空。");
    await renameSession(nativeSessionId, title, { dir: cwd });
    return { ok: true };
  }

  private async deleteSessionOp(params: JsonObject, context: AgentRequestContext) {
    const { cwd, nativeSessionId } = this.sessionIdentity(params, context);
    await this.assertKnownNativeSession(cwd, nativeSessionId);
    await deleteSession(nativeSessionId, { dir: cwd });
    return { ok: true };
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

  private rememberNativeSession(cwd: string, nativeSessionId: string) {
    this.knownNativeSessions.add(`${cwd} ${nativeSessionId}`);
  }

  private rememberHistoryEntries(data: unknown[], fallbackCwd: string) {
    for (const item of data) {
      const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
      const thread = record.thread && typeof record.thread === "object" && !Array.isArray(record.thread) ? record.thread as Record<string, unknown> : record;
      const nativeSessionId = typeof thread.id === "string" ? thread.id : "";
      const entryCwd = typeof thread.cwd === "string" && thread.cwd.trim() ? canonicalWorkspace(thread.cwd) : fallbackCwd;
      if (nativeSessionId && entryCwd) this.rememberNativeSession(entryCwd, nativeSessionId);
    }
  }

  private async assertKnownNativeSession(cwd: string, nativeSessionId: string) {
    if (this.knownNativeSessions.has(`${cwd} ${nativeSessionId}`)) return;
    const info = await getSessionInfo(nativeSessionId, { dir: cwd });
    if (!info || typeof info !== "object") throw new Error("Claude 会话不存在或不属于当前工作区。");
    this.rememberNativeSession(cwd, nativeSessionId);
  }
}
