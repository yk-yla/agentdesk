import type { AgentEventEnvelope, AgentProvider } from "../../../shared/agentProtocol";
import type { Activity, Message, ModelOption, PendingApproval, SessionState, UserInputQuestion } from "../../domain";
import { asRecord, numberValue, stringValue } from "../../domain";
import { timestampFromUnknown } from "../../messageTimestamp";

export interface RoutedClaudeEvent {
  provider: AgentProvider;
  kind: "ready" | "sessionDeleted" | "backendExited" | "closeActiveTab" | "skillsChanged" | "activateSession" | "lateResponse" | "openWorkspace" | "sessionStarted" | "sessionSettingsUpdated" | "turnCompleted" | "state";
  envelope: AgentEventEnvelope;
  nativeSessionId?: string;
  clientSessionId?: string;
  turnStatus?: string;
  settings?: { model?: string; effort?: string };
  batched: boolean;
  lifecycle: boolean;
  providerEvent: RoutedClaudeEvent;
}

function sdkPayload(envelope: AgentEventEnvelope) {
  return asRecord(envelope.payload);
}

export function adaptClaudeEvent(envelope: AgentEventEnvelope): RoutedClaudeEvent {
  const payload = sdkPayload(envelope);
  const type = stringValue(payload.type);
  const nativeSessionId = stringValue(payload.nativeSessionId, stringValue(payload.session_id)) || undefined;
  const isResult = envelope.type === "claude/sdkMessage" && type === "result";
  const kind: RoutedClaudeEvent["kind"] = envelope.type === "claude/sessionStarted"
    ? "sessionStarted"
    : envelope.type === "claude/backendExited"
      ? "backendExited"
      : envelope.type === "claude/turnCompleted" || envelope.type === "claude/error" || isResult
        ? "turnCompleted"
        : envelope.type === "claude/sessionSettingsUpdated"
          ? "sessionSettingsUpdated"
          : "state";
  const event = {
    provider: "claude" as const,
    kind,
    envelope,
    nativeSessionId,
    clientSessionId: envelope.sessionId,
    turnStatus: kind === "turnCompleted"
      ? envelope.type === "claude/turnCompleted" ? stringValue(payload.status, "completed") : envelope.type === "claude/error" || payload.is_error === true ? "failed" : "completed"
      : undefined,
    settings: kind === "sessionSettingsUpdated" ? { model: stringValue(payload.model) || undefined, effort: stringValue(payload.effort) || undefined } : undefined,
    batched: envelope.type === "claude/sdkMessage" && type === "stream_event",
    lifecycle: envelope.type === "claude/turnStarted" || envelope.type === "claude/turnCompleted" || envelope.type === "claude/error" || envelope.type === "claude/interactionPending" || envelope.type === "claude/interactionFinished" || isResult,
  };
  return Object.assign(event, { providerEvent: event }) as RoutedClaudeEvent;
}

function textBlocks(value: unknown) {
  const message = asRecord(value);
  if (typeof message.content === "string") {
    const command = message.content.match(/<command-name>([^<]+)<\/command-name>/)?.[1]?.trim();
    return command || message.content;
  }
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks.map((block) => {
    const item = asRecord(block);
    return item.type === "text" ? stringValue(item.text) : "";
  }).filter(Boolean).join("\n");
}

function claudeMessageId(value: ReturnType<typeof asRecord>, fallback: string) {
  const message = asRecord(value.message);
  const messageId = stringValue(message.id);
  if (messageId) return `claude-message-${messageId}`;
  const uuid = stringValue(value.uuid);
  return uuid ? `claude-message-${uuid}` : fallback;
}

function compactionEventId(payload: ReturnType<typeof asRecord>, fallback = "") {
  const id = stringValue(payload.uuid, stringValue(payload.id));
  return id || fallback ? `claude-compaction-${id || fallback}` : "";
}

function claudeToolKind(name: string): Activity["kind"] {
  if (name === "Bash") return "commandExecution";
  if (name === "Edit" || name === "Write") return "fileChange";
  return "other";
}

function mergeMessages(snapshot: Message[], current: Message[], preferCurrent: boolean) {
  if (!preferCurrent) return snapshot;
  const result = [...snapshot];
  const indexes = new Map(result.map((message, index) => [message.id, index]));
  for (const message of current) {
    const index = indexes.get(message.id);
    if (index === undefined) {
      indexes.set(message.id, result.length);
      result.push(message);
    } else {
      result[index] = message;
    }
  }
  return result;
}

function upsertAssistant(session: SessionState, id: string, text: string, streaming: boolean, timestamp?: number) {
  const existing = session.messages.find((message) => message.id === id);
  if (existing) {
    if (existing.text === text && existing.streaming === streaming && (existing.timestamp || !timestamp)) return;
    session.messages = session.messages.map((message) => message.id === id ? { ...message, text, streaming, timestamp: message.timestamp || timestamp } : message);
  } else if (text) {
    session.messages = [...session.messages, { id, role: "assistant", text, images: [], streaming, timestamp }];
  }
}

function lastStreamingAssistantIndex(messages: Message[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.streaming) return index;
  }
  return -1;
}

function startStreamingAssistant(session: SessionState, id: string, timestamp?: number) {
  if (!id || session.messages.some((message) => message.id === id)) return;
  session.messages = [...session.messages, { id, role: "assistant", text: "", images: [], streaming: true, timestamp }];
}

function appendStreamingAssistant(session: SessionState, text: string, timestamp?: number) {
  if (!text) return;
  const index = lastStreamingAssistantIndex(session.messages);
  if (index >= 0) {
    const current = session.messages[index];
    session.messages = session.messages.map((message, messageIndex) => messageIndex === index
      ? { ...message, text: `${current.text}${text}`, streaming: true }
      : message);
    return;
  }
  const id = `claude-stream-${session.activeTurnId || "current"}-${session.messages.length}`;
  session.messages = [...session.messages, { id, role: "assistant", text, images: [], streaming: true, timestamp }];
}

function finalizeAssistant(session: SessionState, id: string, text: string, timestamp?: number) {
  const existingIndex = session.messages.findIndex((message) => message.id === id);
  if (existingIndex >= 0) {
    const existing = session.messages[existingIndex];
    if (text) {
      session.messages = session.messages.map((message, messageIndex) => messageIndex === existingIndex ? { ...message, text, streaming: false, timestamp: message.timestamp || timestamp } : message);
    } else if (!existing.text && existing.streaming) {
      session.messages = session.messages.filter((_message, messageIndex) => messageIndex !== existingIndex);
    }
    return;
  }
  if (!text) return;
  const streamingIndex = lastStreamingAssistantIndex(session.messages);
  if (streamingIndex >= 0) {
    session.messages = session.messages.map((message, messageIndex) => messageIndex === streamingIndex
      ? { ...message, id, text, streaming: false, timestamp: message.timestamp || timestamp }
      : message);
    return;
  }
  upsertAssistant(session, id, text, false, timestamp);
}

function upsertActivity(session: SessionState, activity: Activity) {
  session.activities = session.activities.some((entry) => entry.id === activity.id)
    ? session.activities.map((entry) => entry.id === activity.id ? { ...entry, ...activity } : entry)
    : [...session.activities, activity];
}

function settleRunningActivities(session: SessionState, status: "completed" | "failed", detail: string) {
  if (!session.activities.some((activity) => activity.status === "inProgress")) return;
  session.activities = session.activities.map((activity) => activity.status === "inProgress"
    ? { ...activity, status, detail: activity.detail ? `${activity.detail}\n${detail}` : detail }
    : activity);
}

function usageFromResult(payload: ReturnType<typeof asRecord>, previous: SessionState["tokenUsage"]) {
  const models = asRecord(payload.modelUsage);
  let used = 0;
  let total: number | null = null;
  for (const value of Object.values(models)) {
    const usage = asRecord(value);
    used += numberValue(usage.inputTokens) + numberValue(usage.outputTokens) + numberValue(usage.cacheReadInputTokens) + numberValue(usage.cacheCreationInputTokens);
    const window = numberValue(usage.contextWindow);
    if (window > 0) total = Math.max(total || 0, window);
  }
  if (!used) {
    const usage = asRecord(payload.usage);
    used = numberValue(usage.input_tokens) + numberValue(usage.output_tokens) + numberValue(usage.cache_read_input_tokens) + numberValue(usage.cache_creation_input_tokens);
  }
  return {
    used: used > 0 ? used : previous.used,
    total: total && total > 0 ? total : previous.total,
  };
}

function interactionApproval(routed: RoutedClaudeEvent, payload: ReturnType<typeof asRecord>): PendingApproval | null {
  const interactionId = stringValue(payload.interactionId);
  if (!interactionId) return null;
  const input = asRecord(payload.input);
  const requestId = stringValue(payload.requestId, interactionId);
  const common = {
    requestId,
    method: "claude/interactionPending",
    threadId: stringValue(payload.nativeSessionId),
    interactionId,
    queryGeneration: numberValue(payload.queryGeneration) || routed.envelope.queryGeneration || 0,
    toolUseId: stringValue(payload.toolUseId) || undefined,
    suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : [],
  };
  const kind = stringValue(payload.kind);
  if (kind === "userQuestion") {
    const questions = Array.isArray(input.questions) ? input.questions.map<UserInputQuestion>((value, index) => {
      const question = asRecord(value);
      return {
        id: String(index),
        header: stringValue(question.header) || undefined,
        question: stringValue(question.question, `问题 ${index + 1}`),
        options: Array.isArray(question.options) ? question.options.map((option) => {
          const item = asRecord(option);
          return { label: stringValue(item.label), description: stringValue(item.description) || undefined };
        }).filter((option) => option.label) : [],
        multiSelect: question.multiSelect === true,
        isOther: true,
      };
    }) : [];
    return {
      ...common,
      kind: "userInput",
      title: stringValue(payload.title, "Claude 需要你的回答"),
      detail: stringValue(payload.description, "回答后 Claude 将继续执行。"),
      questions,
    };
  }
  if (kind === "mcpElicitation") {
    return {
      ...common,
      kind: "elicitation",
      title: stringValue(payload.title, stringValue(payload.displayName, "MCP 请求输入")),
      detail: stringValue(payload.description, stringValue(payload.message, "MCP 服务等待输入。")),
      elicitationMode: stringValue(payload.mode) === "url" ? "url" : "form",
      elicitationMessage: stringValue(payload.message),
      elicitationUrl: stringValue(payload.url) || undefined,
      elicitationId: stringValue(payload.elicitationId) || undefined,
      serverName: stringValue(payload.serverName) || undefined,
      requestedSchema: Object.keys(asRecord(payload.requestedSchema)).length ? asRecord(payload.requestedSchema) : undefined,
    };
  }
  const toolName = stringValue(payload.toolName, "Claude 工具");
  const isFile = toolName === "Edit" || toolName === "Write";
  return {
    ...common,
    kind: isFile ? "fileApproval" : "commandApproval",
    title: stringValue(payload.title, stringValue(payload.displayName, `${toolName} 请求授权`)),
    detail: stringValue(payload.description, stringValue(payload.decisionReason, `Claude 请求使用 ${toolName}`)),
    reason: stringValue(payload.decisionReason) || undefined,
    cwd: stringValue(payload.blockedPath) || undefined,
    command: typeof input.command === "string" ? input.command : undefined,
    availableDecisions: ["cancel", "decline", ...(Array.isArray(payload.suggestions) && payload.suggestions.length ? ["acceptForSession"] : []), "accept"],
  };
}

export function applyClaudeEvent(source: SessionState, routed: RoutedClaudeEvent) {
  const incomingGeneration = routed.envelope.queryGeneration;
  // A closed/restarted Query can still flush events through the Worker host.
  // Older generations must never change capabilities, approvals or lifecycle
  // state belonging to the current Query.
  if (Number.isSafeInteger(incomingGeneration) && Number(incomingGeneration) < source.queryGeneration) {
    return { session: source, approval: null, ignored: true };
  }
  const session: SessionState = { ...source };
  let approval: PendingApproval | null = null;
  if (Number.isSafeInteger(routed.envelope.queryGeneration) && Number(routed.envelope.queryGeneration) >= session.queryGeneration) {
    session.queryGeneration = Number(routed.envelope.queryGeneration);
  }
  const payload = sdkPayload(routed.envelope);
  if (routed.envelope.type === "claude/queryClosed" || routed.envelope.type === "claude/queryRestarted") {
    session.status = "idle";
    session.statusLabel = "已断开，可继续恢复";
    session.activeTurnId = null;
    session.startedAt = null;
    session.pendingApprovals = [];
    session.resumed = false;
    session.capabilities = { ...session.capabilities, models: "temporarilyUnavailable", effort: "temporarilyUnavailable", compact: "temporarilyUnavailable", skills: "temporarilyUnavailable", commands: "temporarilyUnavailable", mcp: "temporarilyUnavailable", pluginsLoad: "temporarilyUnavailable", subagents: "temporarilyUnavailable", contextUsage: "temporarilyUnavailable" };
    settleRunningActivities(session, "failed", "Claude Query 已关闭。");
  } else if (routed.envelope.type === "claude/sessionSettingsUpdated") {
    const model = stringValue(payload.model);
    if (model) {
      session.model = model;
      session.resolvedModel = undefined;
    }
    session.effort = stringValue(payload.effort, session.effort);
  } else if (routed.envelope.type === "claude/capabilitiesUpdated") {
    const capabilities = asRecord(payload.capabilities);
    session.capabilities = { ...session.capabilities, ...capabilities } as SessionState["capabilities"];
  } else if (routed.envelope.type === "claude/contextUsage") {
    const usedValue = payload.used;
    const totalValue = payload.total;
    session.tokenUsage = {
      used: typeof usedValue === "number" && Number.isFinite(usedValue) ? usedValue : session.tokenUsage.used,
      total: typeof totalValue === "number" && Number.isFinite(totalValue) && totalValue > 0 ? totalValue : session.tokenUsage.total,
    };
  } else if (routed.envelope.type === "claude/interactionPending") {
    approval = interactionApproval(routed, payload);
  } else if (routed.envelope.type === "claude/interactionFinished") {
    const interactionId = stringValue(payload.interactionId);
    session.pendingApprovals = session.pendingApprovals.filter((entry) => entry.interactionId !== interactionId);
  } else if (routed.envelope.type === "claude/turnStarted") {
    session.status = "working";
    session.statusLabel = "工作中";
    session.activeTurnId = stringValue(payload.turnId) || session.activeTurnId;
    session.startedAt = Date.now();
    session.errorText = "";
  } else if (routed.envelope.type === "claude/error" || routed.envelope.type === "claude/backendExited") {
    session.status = "error";
    session.statusLabel = "执行失败";
    session.activeTurnId = null;
    session.startedAt = null;
    session.errorText = stringValue(payload.message, "Claude Code 执行失败。");
    session.messages = session.messages.map((message) => message.streaming ? { ...message, streaming: false } : message);
    session.pendingApprovals = [];
    settleRunningActivities(session, "failed", routed.envelope.type === "claude/backendExited" ? "Claude Worker 已退出。" : "Claude 回合失败。");
  } else if (routed.envelope.type === "claude/turnCompleted") {
    const interrupted = stringValue(payload.status) === "interrupted";
    session.status = "idle";
    session.statusLabel = stringValue(payload.status) === "interrupted" ? "已中断" : "就绪";
    session.activeTurnId = null;
    session.startedAt = null;
    session.messages = session.messages.map((message) => message.streaming ? { ...message, streaming: false } : message);
    settleRunningActivities(session, interrupted ? "failed" : "completed", interrupted ? "随回合中断结束。" : "随回合结束。");
  } else if (routed.envelope.type === "claude/sdkMessage") {
    const type = stringValue(payload.type);
    const subtype = stringValue(payload.subtype);
    const messageTimestamp = timestampFromUnknown(payload.timestamp) || routed.envelope.receivedAt;
    if (type === "stream_event") {
      const stream = asRecord(payload.event);
      const delta = asRecord(stream.delta);
      if (stream.type === "message_start") {
        const message = asRecord(stream.message);
        const messageId = stringValue(message.id);
        if (messageId) startStreamingAssistant(session, `claude-message-${messageId}`, messageTimestamp);
      } else if (stream.type === "content_block_delta" && delta.type === "text_delta") {
        appendStreamingAssistant(session, stringValue(delta.text), messageTimestamp);
      } else if (stream.type === "content_block_start") {
        const block = asRecord(stream.content_block);
        const id = stringValue(block.id);
        const name = stringValue(block.name, "Claude 工具");
        if (block.type === "tool_use" && id) {
          upsertActivity(session, {
            id,
            kind: claudeToolKind(name),
            title: name,
            detail: `${name} 参数生成中`,
            status: "inProgress",
            visibleInMain: false,
          });
        }
      }
    } else if (type === "assistant") {
      const id = claudeMessageId(payload, `claude-turn-${session.activeTurnId || "current"}`);
      const text = textBlocks(payload.message);
      finalizeAssistant(session, id, text, messageTimestamp);
      const message = asRecord(payload.message);
      for (const blockValue of Array.isArray(message.content) ? message.content : []) {
        const block = asRecord(blockValue);
        if (block.type !== "tool_use") continue;
        upsertActivity(session, {
          id: stringValue(block.id, `claude-tool-${Date.now()}`),
          kind: claudeToolKind(stringValue(block.name)),
          title: stringValue(block.name, "Claude 工具"),
          detail: stringValue(block.name, "Claude 工具调用"),
          status: "inProgress",
          visibleInMain: false,
        });
      }
    } else if (type === "tool_progress") {
      upsertActivity(session, {
        id: stringValue(payload.tool_use_id, `claude-tool-${Date.now()}`),
        kind: stringValue(payload.tool_name) === "Bash" ? "commandExecution" : "other",
        title: stringValue(payload.tool_name, "Claude 工具"),
        detail: `已运行 ${numberValue(payload.elapsed_time_seconds)} 秒`,
        status: "inProgress",
        visibleInMain: false,
      });
    } else if (type === "result") {
      const failed = payload.is_error === true;
      session.status = failed ? "error" : "idle";
      session.statusLabel = failed ? "执行失败" : "就绪";
      session.errorText = failed ? (Array.isArray(payload.errors) ? payload.errors.map(String).join("\n") : "Claude Code 执行失败。") : "";
      session.activeTurnId = null;
      session.startedAt = null;
      session.tokenUsage = usageFromResult(payload, session.tokenUsage);
      session.messages = session.messages.map((message) => message.streaming ? { ...message, streaming: false } : message);
      settleRunningActivities(session, failed ? "failed" : "completed", failed ? "随失败回合结束。" : "随回合结束。");
    } else if (type === "system" && subtype === "compact_boundary") {
      const eventId = compactionEventId(payload, `${routed.envelope.queryGeneration || 0}-${routed.envelope.receivedAt}`);
      if (!eventId || !session.compactionEventIds.includes(eventId)) {
        session.compactionCount += 1;
        if (eventId) session.compactionEventIds = [...session.compactionEventIds, eventId].slice(-64);
      }
    } else if (type === "system" && subtype === "init") {
      const resolvedModel = stringValue(payload.model);
      if (resolvedModel) {
        session.resolvedModel = resolvedModel;
        if (!session.model) session.model = resolvedModel;
      }
      session.resumed = true;
    }
  }
  return { session, approval, ignored: false };
}

export function hydrateClaudeSession(
  session: SessionState,
  value: unknown,
  options: { preserveRealtime?: boolean; preserveLifecycle?: boolean; persistedCompactionCount?: number; persistedCompactionEventIds?: string[] } = {},
): SessionState {
  const thread = asRecord(value);
  const historyModel = stringValue(thread.model);
  let compactionCount = session.compactionCount;
  const historicalCompactionEventIds: string[] = [];
  const snapshotMessages = Array.isArray(thread.messages) ? (() => {
    const order: string[] = [];
    const byId = new Map<string, Message>();
    compactionCount = 0;
    thread.messages.forEach((entry, index) => {
      const item = asRecord(entry);
      const role = stringValue(item.type);
      if (role === "system" && stringValue(item.subtype) === "compact_boundary") {
        compactionCount += 1;
        const eventId = compactionEventId(item, `history-${index}`);
        if (eventId) historicalCompactionEventIds.push(eventId);
      }
      const text = textBlocks(item.message);
      if ((role !== "user" && role !== "assistant") || !text) return;
      const id = claudeMessageId(item, `claude-history-${role}-${index}`);
      if (!byId.has(id)) order.push(id);
      byId.set(id, { id, role, text, images: [], timestamp: timestampFromUnknown(item.timestamp) });
    });
    return order.flatMap((id) => byId.get(id) || []);
  })() : session.messages;
  const preserveRealtime = options.preserveRealtime === true;
  const preserveLifecycle = options.preserveLifecycle ?? preserveRealtime;
  const nativeTitle = stringValue(thread.name, stringValue(thread.title));
  return {
    ...session,
    threadId: stringValue(thread.id, session.threadId || "") || session.threadId,
    cwd: stringValue(thread.cwd, session.cwd),
    title: nativeTitle || session.title,
    ...(nativeTitle ? { titleOrigin: "provider" as const } : {}),
    ...(historyModel && !session.resumed ? { model: historyModel, resolvedModel: historyModel } : {}),
    messages: mergeMessages(snapshotMessages, session.messages, preserveRealtime),
    compactionCount: Math.max(compactionCount, options.persistedCompactionCount || 0, preserveRealtime ? session.compactionCount : 0),
    compactionEventIds: [...new Set([
      ...(options.persistedCompactionEventIds || []),
      ...(preserveRealtime ? session.compactionEventIds : []),
      ...historicalCompactionEventIds,
    ])].slice(-64),
    resumed: true,
    ...(preserveLifecycle ? {} : {
      status: "idle" as const,
      statusLabel: "就绪",
      activeTurnId: null,
      startedAt: null,
    }),
  };
}

export function normalizeClaudeModel(value: unknown): ModelOption {
  const model = asRecord(value);
  const efforts = Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.map(String) : [];
  return {
    id: stringValue(model.value),
    resolvedId: stringValue(model.resolvedModel) || undefined,
    displayName: stringValue(model.displayName, stringValue(model.value, "Claude")),
    description: stringValue(model.description),
    efforts,
    defaultEffort: efforts.includes("medium") ? "medium" : efforts[0] || "",
    supportsImage: true,
  };
}
