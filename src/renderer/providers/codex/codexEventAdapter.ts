import type { AgentEventEnvelope, AgentOperation, AgentProvider } from "../../../shared/agentProtocol";
import type { JsonObject, JsonRpcMessage } from "../../../shared/protocol";
import type { Activity, ActivityKind, ActivityStatus, ImageAttachment, Message, PendingApproval, PlanStepStatus, RetryState, SessionGoal, SessionPlan, SessionState, SubagentState, SubagentStatus, UserInputQuestion } from "../../domain";
import { asRecord, imageFromContent, numberValue, stringValue, textFromContent } from "../../domain";

const ACTIVITY_OUTPUT_LIMIT = 64 * 1024;
const ACTIVITY_DETAIL_LIMIT = 8 * 1024;
const SESSION_MESSAGE_LIMIT = 5_000;
const SESSION_ACTIVITY_LIMIT = 5_000;
const SESSION_SUBAGENT_LIMIT = 1_000;
const TRUNCATION_MARKER = "\n…输出过长，完整内容请查看原始事件。";
const BACKGROUND_TIMEOUT_ERROR = "请求超时，任务可能仍在后台执行。";

function limitActivityText(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}

function appendActivityText(current: string, delta: string, limit: number) {
  if (!delta || current.endsWith(TRUNCATION_MARKER)) return current;
  return limitActivityText(`${current}${delta}`, limit);
}

function activityKind(value: unknown): ActivityKind {
  if (value === "commandExecution" || value === "fileChange" || value === "mcpToolCall" || value === "plan" || value === "reasoning" || value === "subAgent") return value;
  if (value === "collabAgentToolCall" || value === "subAgentActivity") return "subAgent";
  return "other";
}

function activityStatus(value: unknown, previous?: Activity, fallback: ActivityStatus = "inProgress"): ActivityStatus {
  if (value === "failed" || value === "declined" || value === "completed" || value === "inProgress" || value === "interrupted") return value;
  if (fallback !== "inProgress") return fallback;
  return previous?.status ?? fallback;
}

const GOAL_STATUSES = new Set(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);
const PLAN_STATUSES = new Set(["pending", "inProgress", "completed"]);
const SUBAGENT_STATUSES = new Set(["pendingInit", "running", "interrupted", "completed", "errored", "shutdown", "notFound"]);
const RETRY_RECOVERY_METHODS = new Set([
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/reasoning/summaryTextDelta",
  "turn/diff/updated",
  "turn/plan/updated",
]);

const BATCHED_METHODS = new Set([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/reasoning/summaryTextDelta",
  "turn/diff/updated",
  "turn/plan/updated",
  "thread/tokenUsage/updated",
]);

const OPERATION_BY_METHOD: Record<string, AgentOperation> = {
  "model/list": "listModels",
  "skills/list": "listSkills",
  "thread/list": "listSessions",
  "thread/search": "searchSessions",
  "thread/read": "readSession",
  "thread/start": "startSession",
  "thread/resume": "resumeSession",
  "thread/fork": "forkSession",
  "thread/name/set": "renameSession",
  "thread/delete": "deleteSession",
  "thread/metadata/update": "updateSessionMetadata",
  "thread/settings/update": "updateSessionSettings",
  "turn/start": "startTurn",
  "review/start": "startReview",
  "turn/steer": "steerTurn",
  "turn/interrupt": "interruptTurn",
  "thread/compact/start": "compactSession",
};

export interface RoutedCodexEvent {
  provider: AgentProvider;
  kind: "ready" | "sessionDeleted" | "backendExited" | "closeActiveTab" | "skillsChanged" | "activateSession" | "lateResponse" | "openWorkspace" | "sessionStarted" | "sessionSettingsUpdated" | "turnCompleted" | "state";
  envelope: AgentEventEnvelope;
  message: JsonRpcMessage;
  nativeSessionId?: string;
  parentNativeSessionId?: string;
  childNativeSessionId?: string;
  clientSessionId?: string;
  workspace?: string;
  launchProvider?: AgentProvider;
  turnStatus?: string;
  committedClientId?: string;
  settings?: { model?: string; effort?: string };
  lateResponse?: { operation?: AgentOperation; result?: unknown; error?: unknown };
  batched: boolean;
  lifecycle: boolean;
  providerEvent: RoutedCodexEvent;
}

export function adaptCodexEvent(envelope: AgentEventEnvelope): RoutedCodexEvent {
  const params = envelope.payload && typeof envelope.payload === "object" && !Array.isArray(envelope.payload)
    ? envelope.payload as JsonObject
    : {};
  const method = envelope.type;
  const message: JsonRpcMessage = { ...(envelope.requestId !== undefined ? { id: envelope.requestId } : {}), method, params };
  const thread = asRecord(params.thread);
  const nativeSessionId = stringValue(thread.id) || threadIdForMessage(message) || undefined;
  const source = asRecord(asRecord(thread.source).subAgent);
  const spawn = asRecord(source.thread_spawn);
  const parentNativeSessionId = stringValue(thread.parentThreadId) || stringValue(spawn.parent_thread_id) || undefined;
  const item = asRecord(params.item);
  const childNativeSessionId = item.type === "subAgentActivity" ? stringValue(item.agentThreadId) || undefined : undefined;
  const settings = asRecord(params.threadSettings);
  const response = asRecord(params.response);
  const requestMethod = stringValue(params.requestMethod);
  const kind: RoutedCodexEvent["kind"] =
    method === "client/ready" ? "ready"
      : method === "thread/deleted" ? "sessionDeleted"
        : method === "client/server-exited" ? "backendExited"
          : method === "client/close-active-tab" ? "closeActiveTab"
            : method === "skills/changed" ? "skillsChanged"
              : method === "client/activate-session" ? "activateSession"
                : method === "client/late-response" ? "lateResponse"
                  : method === "client/open-workspace" ? "openWorkspace"
                    : method === "thread/started" ? "sessionStarted"
                      : method === "thread/settings/updated" ? "sessionSettingsUpdated"
                        : method === "turn/completed" ? "turnCompleted"
                          : "state";
  const event = {
    provider: "codex" as const,
    kind,
    envelope,
    message,
    nativeSessionId,
    parentNativeSessionId,
    childNativeSessionId,
    clientSessionId: stringValue(params.sessionId) || undefined,
    workspace: stringValue(params.workspace) || undefined,
    launchProvider: params.provider === "codex" || params.provider === "claude" ? params.provider : undefined,
    turnStatus: kind === "turnCompleted" ? stringValue(asRecord(params.turn).status, "completed") : undefined,
    committedClientId: (method === "item/started" || method === "item/completed") && item.type === "userMessage"
      ? stringValue(item.clientId, stringValue(item.client_id)) || undefined
      : undefined,
    settings: kind === "sessionSettingsUpdated"
      ? { model: stringValue(settings.model) || undefined, effort: stringValue(settings.effort) || undefined }
      : undefined,
    lateResponse: kind === "lateResponse"
      ? { operation: OPERATION_BY_METHOD[requestMethod], result: response.result, error: response.error }
      : undefined,
    batched: BATCHED_METHODS.has(method),
    lifecycle: method === "turn/started" || method === "turn/completed" || method === "error",
  };
  return Object.assign(event, { providerEvent: event }) as RoutedCodexEvent;
}

function planStepStatus(value: unknown): PlanStepStatus {
  return PLAN_STATUSES.has(String(value)) ? value as PlanStepStatus : "pending";
}

function subagentStatus(value: unknown, fallback: SubagentStatus = "pendingInit"): SubagentStatus {
  return SUBAGENT_STATUSES.has(String(value)) ? value as SubagentStatus : fallback;
}

function planFromParams(value: unknown): SessionPlan {
  const params = asRecord(value);
  const plan = Array.isArray(params.plan) ? params.plan.map((entry) => {
    const item = asRecord(entry);
    return { step: stringValue(item.step, "未命名步骤"), status: planStepStatus(item.status) };
  }).filter((entry) => entry.step) : [];
  return { explanation: stringValue(params.explanation), steps: plan, updatedAt: Date.now() };
}

function settlePlan(plan: SessionPlan | null, turnStatus: string): SessionPlan | null {
  if (!plan || !plan.steps.some((step) => step.status === "inProgress")) return plan;
  const status: PlanStepStatus = turnStatus === "completed" ? "completed" : "pending";
  return {
    ...plan,
    steps: plan.steps.map((step) => step.status === "inProgress" ? { ...step, status } : step),
    updatedAt: Date.now(),
  };
}

function retryStateFromParams(source: SessionState, params: ReturnType<typeof asRecord>): RetryState {
  const error = asRecord(params.error);
  const turnId = stringValue(params.turnId, source.activeTurnId || "");
  const previous = source.retryState;
  return {
    turnId,
    attempt: previous && previous.turnId === turnId ? previous.attempt + 1 : 1,
    message: limitActivityText(stringValue(error.message, "上游服务暂时不可用"), ACTIVITY_DETAIL_LIMIT),
    additionalDetails: limitActivityText(stringValue(error.additionalDetails), ACTIVITY_DETAIL_LIMIT),
    previousStatusLabel: previous?.previousStatusLabel || source.statusLabel || "工作中",
  };
}

export function goalFromValue(value: unknown): SessionGoal | null {
  const goal = asRecord(value);
  const threadId = stringValue(goal.threadId);
  const objective = stringValue(goal.objective);
  const status = stringValue(goal.status);
  if (!threadId || !objective || !GOAL_STATUSES.has(status)) return null;
  return {
    threadId,
    objective,
    status: status as SessionGoal["status"],
    tokenBudget: typeof goal.tokenBudget === "number" && Number.isFinite(goal.tokenBudget) ? goal.tokenBudget : null,
    tokensUsed: numberValue(goal.tokensUsed),
    timeUsedSeconds: numberValue(goal.timeUsedSeconds),
    createdAt: numberValue(goal.createdAt),
    updatedAt: numberValue(goal.updatedAt),
  };
}

export function threadIdForMessage(message: JsonRpcMessage): string | null {
  const params = asRecord(message.params);
  const direct = stringValue(params.threadId);
  if (direct) return direct;
  const thread = asRecord(params.thread);
  return stringValue(thread.id) || stringValue(params.conversationId) || null;
}

function activityFromItem(itemValue: unknown, previous?: Activity, fallbackStatus: ActivityStatus = "inProgress"): Activity {
  const item = asRecord(itemValue);
  const kind = activityKind(item.type);
  const id = stringValue(item.id, previous?.id ?? `activity-${Date.now()}`);
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const paths = changes.map((change) => stringValue(asRecord(change).path)).filter(Boolean).join(", ");
  const output = limitActivityText(stringValue(item.aggregatedOutput, previous?.output ?? ""), ACTIVITY_OUTPUT_LIMIT);
  const detail = limitActivityText(kind === "commandExecution"
    ? stringValue(item.command, previous?.detail ?? "后台命令")
    : kind === "fileChange"
      ? paths || previous?.detail || "文件修改"
      : kind === "mcpToolCall"
        ? `${stringValue(item.server, "MCP")} / ${stringValue(item.tool, "工具")}`
        : kind === "reasoning"
          ? (Array.isArray(item.summary) ? item.summary.map((entry) => stringValue(entry)).filter(Boolean).join("\n") : stringValue(item.summary, previous?.detail || "思考摘要"))
          : kind === "subAgent"
            ? `${stringValue(item.tool, stringValue(item.kind, "子 Agent"))}${stringValue(item.prompt) ? `：${stringValue(item.prompt)}` : ""}`
          : kind === "plan"
            ? "执行计划"
          : previous?.detail || stringValue(item.text, "后台活动"), ACTIVITY_DETAIL_LIMIT);
  const status = activityStatus(item.status, previous, fallbackStatus);
  return {
    id, kind, title: kind === "commandExecution" ? "代理命令" : kind === "fileChange" ? "文件修改" : kind === "mcpToolCall" ? "工具调用" : kind === "plan" ? "任务计划" : kind === "reasoning" ? "思考摘要" : kind === "subAgent" ? "子 Agent" : "后台活动",
    detail, status, output, visibleInMain: (kind === "fileChange" || kind === "mcpToolCall" || kind === "other") && (status === "failed" || status === "declined" || status === "interrupted"),
  };
}

function upsertSubagentFromItem(session: SessionState, itemValue: unknown) {
  const item = asRecord(itemValue);
  const type = stringValue(item.type);
  const now = Date.now();
  if (type === "subAgentActivity") {
    const threadId = stringValue(item.agentThreadId);
    if (!threadId) return;
    const kind = stringValue(item.kind);
    const existing = session.subagents.find((entry) => entry.threadId === threadId);
    const next: SubagentState = {
      threadId, nickname: existing?.nickname || "子 Agent", role: existing?.role || "",
      prompt: existing?.prompt || "", model: existing?.model || "", effort: existing?.effort || "",
      status: kind === "interrupted" ? "interrupted" : kind === "started" ? "running" : existing?.status || "running",
      message: existing?.message || "", updatedAt: now,
    };
    session.subagents = existing ? session.subagents.map((entry) => entry.threadId === threadId ? next : entry) : [...session.subagents, next];
    return;
  }
  if (type !== "collabAgentToolCall") return;
  const receiverIds = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map((entry) => stringValue(entry)).filter(Boolean) : [];
  const states = asRecord(item.agentsStates);
  if (!receiverIds.length) return;
  const prompt = stringValue(item.prompt);
  const model = stringValue(item.model);
  const effort = stringValue(item.reasoningEffort);
  const tool = stringValue(item.tool);
  const nextItems = [...session.subagents];
  for (const threadId of receiverIds) {
    const existing = nextItems.find((entry) => entry.threadId === threadId);
    const state = asRecord(states[threadId]);
    const next: SubagentState = {
      threadId, nickname: existing?.nickname || `子 Agent ${nextItems.length + 1}`,
      role: existing?.role || "", prompt: prompt || existing?.prompt || "", model: model || existing?.model || "", effort: effort || existing?.effort || "",
      status: subagentStatus(state.status, stringValue(item.status) === "failed" ? "errored" : tool === "closeAgent" && stringValue(item.status) === "completed" ? "shutdown" : existing?.status || "running"), message: stringValue(state.message, existing?.message || ""), updatedAt: now,
    };
    const index = nextItems.findIndex((entry) => entry.threadId === threadId);
    if (index >= 0) nextItems[index] = next; else nextItems.push(next);
  }
  session.subagents = nextItems;
}

function updateSubagentState(session: SessionState, threadId: string, patch: Partial<SubagentState>) {
  if (!threadId) return;
  const existing = session.subagents.find((entry) => entry.threadId === threadId);
  const next: SubagentState = {
    threadId, nickname: existing?.nickname || "子 Agent", role: existing?.role || "", prompt: existing?.prompt || "", model: existing?.model || "", effort: existing?.effort || "",
    status: existing?.status || "pendingInit", message: existing?.message || "", updatedAt: Date.now(), ...patch,
  };
  session.subagents = existing ? session.subagents.map((entry) => entry.threadId === threadId ? next : entry) : [...session.subagents, next];
}

function upsertActivity(session: SessionState, item: unknown, fallbackStatus: ActivityStatus = "inProgress") {
  const previous = session.activities.find((entry) => entry.id === stringValue(asRecord(item).id));
  const next = activityFromItem(item, previous, fallbackStatus);
  const existingIndex = session.activities.findIndex((entry) => entry.id === next.id);
  session.activities = existingIndex < 0
    ? [...session.activities, next]
    : session.activities.map((entry, index) => index === existingIndex ? next : entry);
}

function ensureAssistantMessage(session: SessionState, id: string, text: string, streaming: boolean, timestamp?: number) {
  const existing = session.messages.find((message) => message.id === id);
  if (existing) {
    session.messages = session.messages.map((message) => message.id === id ? { ...message, text: text || message.text, streaming, timestamp: message.timestamp || timestamp } : message);
  } else if (text) {
    session.messages = [...session.messages, { id, role: "assistant", text, images: [], streaming, timestamp }];
  }
}

function messagesFromItem(itemValue: unknown, timestamp?: number): Message[] {
  const item = asRecord(itemValue);
  const type = stringValue(item.type);
  const id = stringValue(item.id, `item-${Date.now()}`);
  if (type === "agentMessage" || type === "plan") {
    const text = stringValue(item.text);
    return text ? [{ id, role: "assistant", text, images: [], streaming: false, timestamp }] : [];
  }
  if (type === "exitedReviewMode") {
    const review = stringValue(item.review);
    return review ? [{ id: `review-result-${id}`, role: "assistant", text: review, images: [], streaming: false, timestamp }] : [];
  }
  if (type === "imageView" && typeof item.path === "string") return [{ id, role: "assistant", text: "", images: [{ path: item.path, dataUrl: "", name: stringValue(item.name, item.path.split(/[\\/]/).pop() || "图片"), ...(stringValue(item.imageError) ? { error: stringValue(item.imageError) } : {}) }], streaming: false, timestamp }];
  if (type === "imageGeneration") {
    const savedPath = stringValue(item.savedPath);
    const result = stringValue(item.result);
    const image = { path: savedPath, dataUrl: result.startsWith("data:image/") || result.startsWith("http://") || result.startsWith("https://") ? result : "", name: stringValue(item.name, savedPath.split(/[\\/]/).pop() || "生成图片"), ...(stringValue(item.imageError) ? { error: stringValue(item.imageError) } : {}) };
    return [{ id, role: "assistant", text: stringValue(item.revisedPrompt), images: [image], streaming: false, timestamp }];
  }
  if (type !== "userMessage") return [];
  const content = Array.isArray(item.content) ? item.content : [];
  const text = content.map(textFromContent).filter(Boolean).join("\n");
  const images = content.map(imageFromContent).filter((image): image is ImageAttachment => Boolean(image));
  if (!text && !images.length) return [];
  return [{ id, clientId: stringValue(item.clientId, stringValue(item.client_id)) || undefined, role: "user", text, images, timestamp }];
}

function approvalDecisions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return entry;
    const record = asRecord(entry);
    if (typeof record.acceptWithExecpolicyAmendment !== "undefined") return "acceptWithExecpolicyAmendment";
    if (typeof record.applyNetworkPolicyAmendment !== "undefined") return "applyNetworkPolicyAmendment";
    return "";
  }).filter(Boolean);
}

function questionsFromParams(value: unknown): UserInputQuestion[] {
  return Array.isArray(value) ? value.map((entry, index) => {
    const question = asRecord(entry);
    const options = Array.isArray(question.options) ? question.options.map((option) => {
      const record = asRecord(option);
      return { label: stringValue(record.label), description: stringValue(record.description) || undefined };
    }).filter((option) => option.label) : undefined;
    return {
      id: stringValue(question.id, `question-${index + 1}`),
      header: stringValue(question.header) || undefined,
      question: stringValue(question.question, stringValue(question.prompt, "请选择")),
      options,
      multiSelect: question.multiSelect === true || question.multiple === true,
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
    };
  }) : [];
}

function pendingRequestFromMessage(message: JsonRpcMessage): PendingApproval | null {
  const method = message.method || "";
  const params = asRecord(message.params);
  const requestId = message.id ?? `request-${Date.now()}`;
  const threadId = stringValue(params.threadId) || stringValue(params.conversationId);
  const reason = stringValue(params.reason);
  const command = stringValue(params.command) || (Array.isArray(params.command) ? params.command.map((entry) => stringValue(entry)).filter(Boolean).join(" ") : "");

  if (method === "item/commandExecution/requestApproval") {
    const network = asRecord(params.networkApprovalContext);
    const host = stringValue(network.host);
    const protocol = stringValue(network.protocol);
    const detail = host ? `${protocol ? `${protocol}://` : ""}${host}${typeof network.port === "number" ? `:${network.port}` : ""}` : command || reason || "Codex 正在等待你的决定";
    return {
      requestId, method, threadId, kind: "commandApproval",
      title: host ? "网络访问需要确认" : "命令需要确认",
      detail, reason: reason || undefined, cwd: stringValue(params.cwd) || undefined, command: command || undefined,
      availableDecisions: approvalDecisions(params.availableDecisions),
      availableDecisionPayloads: Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined,
      proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
      proposedNetworkPolicyAmendments: Array.isArray(params.proposedNetworkPolicyAmendments) ? params.proposedNetworkPolicyAmendments : undefined,
      networkApprovalContext: Object.keys(network).length ? network : undefined,
    };
  }

  if (method === "item/fileChange/requestApproval") {
    const grantRoot = stringValue(params.grantRoot);
    return {
      requestId, method, threadId, kind: "fileApproval", title: "文件修改需要确认",
      detail: reason || grantRoot || "Codex 正在等待你的决定", reason: reason || undefined, grantRoot: grantRoot || undefined,
      availableDecisions: approvalDecisions(params.availableDecisions),
      availableDecisionPayloads: Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined,
    };
  }

  if (method === "item/permissions/requestApproval") {
    const permissions = asRecord(params.permissions);
    return {
      requestId, method, threadId, kind: "permissionsApproval", title: "权限请求",
      detail: reason || "Codex 请求额外的文件或网络权限", reason: reason || undefined,
      cwd: stringValue(params.cwd) || undefined, permissions,
    };
  }

  if (method === "tool/requestUserInput" || method === "item/tool/requestUserInput") {
    const questions = questionsFromParams(params.questions);
    return {
      requestId, method, threadId, kind: "userInput", title: "需要你的回答",
      detail: stringValue(params.message, questions[0]?.question || "Codex 正在等待补充信息"), questions,
    };
  }

  if (method === "mcpServer/elicitation/request") {
    const mode = stringValue(params.mode);
    const elicitationMode = mode === "url" ? "url" : "form";
    const messageText = stringValue(params.message, "MCP 服务正在等待你的确认");
    return {
      requestId, method, threadId, kind: "elicitation", title: `${stringValue(params.serverName, "MCP")} 请求确认`,
      detail: messageText, elicitationMode, elicitationMessage: messageText,
      elicitationUrl: stringValue(params.url) || undefined, elicitationId: stringValue(params.elicitationId) || undefined,
      serverName: stringValue(params.serverName) || undefined, requestedSchema: asRecord(params.requestedSchema),
    };
  }

  return null;
}

function mergeByKey<T>(snapshot: T[], current: T[], keyFor: (value: T) => string, preferCurrent: boolean) {
  const result = [...snapshot];
  const indexes = new Map(result.map((value, index) => [keyFor(value), index]));
  for (const value of current) {
    const key = keyFor(value);
    const index = key ? indexes.get(key) : undefined;
    if (index === undefined) {
      if (key) indexes.set(key, result.length);
      result.push(value);
    } else if (preferCurrent) {
      result[index] = value;
    }
  }
  return result;
}

function messageKey(message: Message) {
  return message.clientId ? `client:${message.clientId}` : `id:${message.id}`;
}

function enforceSessionBudgets(session: SessionState): SessionState {
  if (session.messages.length > SESSION_MESSAGE_LIMIT) {
    const removed = session.messages.length - SESSION_MESSAGE_LIMIT + 1;
    session.messages = [
      { id: "client-message-history-trimmed", role: "system", text: `较早的 ${removed} 条消息已从当前内存视图清理，可重新打开历史会话读取。`, images: [] },
      ...session.messages.slice(-(SESSION_MESSAGE_LIMIT - 1)),
    ];
  }
  if (session.activities.length > SESSION_ACTIVITY_LIMIT) {
    const removed = session.activities.length - SESSION_ACTIVITY_LIMIT + 1;
    session.activities = [
      { id: "client-activity-history-trimmed", kind: "other", title: "较早活动已清理", detail: `${removed} 条活动已达到内存上限`, status: "completed", visibleInMain: true },
      ...session.activities.slice(-(SESSION_ACTIVITY_LIMIT - 1)),
    ];
  }
  if (session.subagents.length > SESSION_SUBAGENT_LIMIT) session.subagents = session.subagents.slice(-SESSION_SUBAGENT_LIMIT);
  return session;
}

export interface CodexHydrateOptions {
  preserveRealtime?: boolean;
  preserveLifecycle?: boolean;
  persistedCompactionCount?: number;
  persistedCompactionEventIds?: string[];
}

export function hydrateSession(session: SessionState, threadValue: unknown, options: CodexHydrateOptions = {}): SessionState {
  const thread = asRecord(threadValue);
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const messages: Message[] = [];
  const activities: Activity[] = [];
  let compactionCount = 0;
  const historicalCompactionEventIds: string[] = [];
  let plan: SessionPlan | null = session.plan;
  let latestTurnUpdatedAt = 0;
  const subagents: SubagentState[] = [];
  for (const turnValue of turns) {
    const turn = asRecord(turnValue);
    const turnUpdatedAt = numberValue(turn.completedAt, numberValue(turn.startedAt)) * 1000;
    latestTurnUpdatedAt = Math.max(latestTurnUpdatedAt, turnUpdatedAt);
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const item of items) {
      const itemRecord = asRecord(item);
      if (itemRecord.type === "contextCompaction") {
        compactionCount += 1;
        const id = stringValue(itemRecord.id);
        if (id) historicalCompactionEventIds.push(id);
      }
      if (itemRecord.type === "collabAgentToolCall" || itemRecord.type === "subAgentActivity") {
        const draft = { ...session, subagents };
        upsertSubagentFromItem(draft, item);
        subagents.splice(0, subagents.length, ...draft.subagents);
      }
      if (itemRecord.type === "plan" && (!plan || !turnUpdatedAt || turnUpdatedAt >= plan.updatedAt)) {
        plan = { explanation: stringValue(itemRecord.text), steps: [], updatedAt: turnUpdatedAt || Date.now() };
      }
      const role = stringValue(itemRecord.type);
      const messageTimestamp = role === "userMessage"
        ? numberValue(turn.startedAt) * 1000 || undefined
        : numberValue(turn.completedAt, numberValue(turn.startedAt)) * 1000 || undefined;
      const nextMessages = messagesFromItem(item, messageTimestamp);
      if (nextMessages.length) messages.push(...nextMessages);
      if (!["userMessage", "agentMessage"].includes(stringValue(itemRecord.type))) {
        activities.push(activityFromItem(item));
      }
    }
  }
  const lastTurn = asRecord(turns[turns.length - 1]);
  const lastTurnStatus = stringValue(lastTurn.status);
  const snapshotWorking = lastTurnStatus === "inProgress" || lastTurnStatus === "running";
  const snapshotTurnId = snapshotWorking ? stringValue(lastTurn.id) || null : null;
  const preserveRealtime = options.preserveRealtime === true;
  // 内容和生命周期可能由不同事件推进。审批、活动或 token 事件不应阻止历史快照恢复 working 状态。
  const preserveLifecycle = options.preserveLifecycle ?? preserveRealtime;
  const mergedMessages = mergeByKey(messages, session.messages, messageKey, preserveRealtime);
  const mergedActivities = mergeByKey(activities, session.activities, (activity) => activity.id, preserveRealtime);
  const mergedSubagents = mergeByKey(subagents, session.subagents, (subagent) => subagent.threadId, preserveRealtime);
  const compactionEventIds = [...new Set([
    ...(options.persistedCompactionEventIds || []),
    ...(preserveRealtime ? session.compactionEventIds : []),
    ...historicalCompactionEventIds,
  ])].slice(-64);
  const updatedAt = Math.max(numberValue(thread.updatedAt, 0) * 1000, latestTurnUpdatedAt) || Date.now();
  const nativeName = stringValue(thread.name);
  return enforceSessionBudgets({
    ...session,
    threadId: stringValue(thread.id, session.threadId ?? "") || session.threadId,
    cwd: stringValue(thread.cwd, session.cwd),
    title: nativeName || stringValue(thread.preview, session.title) || session.title,
    ...(nativeName ? { titleOrigin: "provider" as const } : {}),
    createdAt: numberValue(thread.createdAt, 0) * 1000 || session.createdAt,
    updatedAt: Math.max(updatedAt, session.updatedAt),
    messages: mergedMessages,
    activities: mergedActivities,
    compactionCount: Math.max(compactionCount, options.persistedCompactionCount || 0, preserveRealtime ? session.compactionCount : 0),
    compactionEventIds,
    plan: preserveRealtime && session.plan && (!plan || session.plan.updatedAt > plan.updatedAt) ? session.plan : plan,
    subagents: mergedSubagents,
    ...(preserveLifecycle ? {} : {
      status: snapshotWorking ? "working" as const : "idle" as const,
      statusLabel: snapshotWorking ? "工作中" : lastTurnStatus === "interrupted" ? "已中断" : lastTurnStatus === "failed" ? "执行失败" : "就绪",
      activeTurnId: snapshotTurnId,
      startedAt: snapshotWorking ? numberValue(lastTurn.startedAt) * 1000 || Date.now() : null,
      errorText: lastTurnStatus === "failed"
        ? stringValue(asRecord(lastTurn.error).message, session.errorText)
        : !snapshotWorking && session.errorText === BACKGROUND_TIMEOUT_ERROR ? "" : session.errorText,
      retryState: null,
    }),
  });
}

export interface AppliedEvent {
  session: SessionState;
  approval: PendingApproval | null;
  ignored: boolean;
}

/**
 * 只复制 session 顶层对象；messages / activities 数组仅在真正变化的分支里替换。
 * 未变化的数组保持同一引用，MessageStack 和 DetailsPanel 的 memo 才能拦住重渲染。
 * 原始事件不再进入这里，由 rawEventStore 在 React 状态之外全量保留。
 */
export function applyServerMessage(source: SessionState, message: JsonRpcMessage, receivedAt = Date.now()): AppliedEvent {
  const session: SessionState = { ...source };
  const params = asRecord(message.params);
  const method = message.method || "";
  if (session.retryState && RETRY_RECOVERY_METHODS.has(method)) {
    session.statusLabel = session.retryState.previousStatusLabel || "工作中";
    session.retryState = null;
  }
  if (method === "turn/started") {
    const turn = asRecord(params.turn);
    session.activeTurnId = stringValue(turn.id) || null;
    session.plan = null;
    session.status = "working";
    session.statusLabel = "工作中";
    session.startedAt = Date.now();
    session.retryState = null;
  } else if (method === "turn/completed") {
    const turn = asRecord(params.turn);
    const status = stringValue(turn.status, "completed");
    // Turn 已结束后队列仍应继续排空；失败信息通过 errorText 单独展示。
    session.status = "idle";
    session.statusLabel = status === "interrupted" ? "已中断" : status === "failed" ? "执行失败" : "就绪";
    session.activeTurnId = null;
    session.startedAt = null;
    session.retryState = null;
    const settledActivityStatus: ActivityStatus = status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "completed";
    if (session.activities.some((activity) => activity.status === "inProgress")) {
      session.activities = session.activities.map((activity) => activity.status === "inProgress" ? { ...activity, status: settledActivityStatus } : activity);
    }
    if (session.messages.some((entry) => entry.streaming)) {
      session.messages = session.messages.map((entry) => entry.streaming ? { ...entry, streaming: false } : entry);
    }
    session.plan = settlePlan(session.plan, status);
    if (status === "failed") session.errorText = stringValue(asRecord(turn.error).message, "任务执行失败");
    else if (session.errorText === BACKGROUND_TIMEOUT_ERROR) session.errorText = "";
  } else if (method === "error") {
    const willRetry = params.willRetry === true;
    if (willRetry) {
      const retry = retryStateFromParams(session, params);
      session.status = "working";
      session.statusLabel = "正在重试";
      session.activeTurnId = retry.turnId || session.activeTurnId;
      session.startedAt = session.startedAt || Date.now();
      session.errorText = "";
      session.retryState = retry;
    } else {
      session.retryState = null;
      session.status = "error";
      session.statusLabel = "执行失败";
      session.activeTurnId = null;
      session.startedAt = null;
      session.errorText = stringValue(asRecord(params.error).message, "任务执行失败");
      if (session.messages.some((entry) => entry.streaming)) {
        session.messages = session.messages.map((entry) => entry.streaming ? { ...entry, streaming: false } : entry);
      }
      session.plan = settlePlan(session.plan, "failed");
    }
  } else if (method === "turn/plan/updated") {
    const currentPlan = planFromParams(params);
    const eventTurnId = stringValue(params.turnId);
    if ((!eventTurnId || !session.activeTurnId || eventTurnId === session.activeTurnId) && (session.status === "working" || session.activeTurnId)) {
      session.plan = currentPlan;
      const activeStep = asRecord(currentPlan.steps.find((entry) => entry.status === "inProgress"));
      session.statusLabel = stringValue(activeStep.step, "工作中");
    }
  } else if (method === "thread/goal/updated") {
    const goal = goalFromValue(params.goal);
    if (goal) session.goal = goal;
  } else if (method === "thread/goal/cleared") {
    session.goal = null;
  } else if (method === "item/agentMessage/delta" || method === "item/plan/delta") {
    const id = stringValue(params.itemId, `assistant-${Date.now()}`);
    const delta = stringValue(params.delta);
    const current = session.messages.find((messageItem) => messageItem.id === id);
    ensureAssistantMessage(session, id, (current?.text ?? "") + delta, true, receivedAt);
    if (method === "item/plan/delta") {
      session.plan = { explanation: (session.plan?.explanation || "") + delta, steps: session.plan?.steps || [], updatedAt: Date.now() };
    }
  } else if (method === "item/started" || method === "item/completed") {
    const item = asRecord(params.item);
    const type = stringValue(item.type);
    const lifecycleTimestamp = numberValue(params.startedAtMs, numberValue(params.completedAtMs, receivedAt));
    if (type === "agentMessage" || type === "plan") {
      const id = stringValue(item.id, `assistant-${Date.now()}`);
      ensureAssistantMessage(session, id, stringValue(item.text), method === "item/started", lifecycleTimestamp);
      if (type === "plan") {
        const updatedAt = numberValue(params.completedAtMs, numberValue(params.startedAtMs, Date.now()));
        if (!session.plan || updatedAt >= session.plan.updatedAt) {
          session.plan = { explanation: stringValue(item.text), steps: session.plan?.steps || [], updatedAt };
        }
        upsertActivity(session, item, method === "item/completed" ? "completed" : "inProgress");
      }
    } else if (type === "exitedReviewMode" && method === "item/completed") {
      const hydrated = messagesFromItem(item, lifecycleTimestamp);
      if (hydrated.length) ensureAssistantMessage(session, hydrated[0].id, hydrated[0].text, false, lifecycleTimestamp);
    } else if ((type === "imageView" || type === "imageGeneration") && method === "item/completed") {
      const hydrated = messagesFromItem(item, lifecycleTimestamp);
      if (hydrated.length && !session.messages.some((entry) => entry.id === hydrated[0].id)) {
        session.messages = [...session.messages, ...hydrated];
      }
    } else if (type === "contextCompaction" && method === "item/completed") {
      const eventId = stringValue(item.id);
      if (!eventId || !session.compactionEventIds.includes(eventId)) {
        session.compactionCount += 1;
        if (eventId) session.compactionEventIds = [...session.compactionEventIds, eventId].slice(-64);
      }
      upsertActivity(session, item, method === "item/completed" ? "completed" : "inProgress");
    } else if (item.type === "userMessage") {
      const hydrated = messagesFromItem(item, lifecycleTimestamp);
      const duplicate = hydrated.length && session.messages.some((entry) => entry.id === hydrated[0].id
        || (hydrated[0].clientId && entry.clientId === hydrated[0].clientId)
        || (entry.role === "user" && !entry.clientId && entry.text === hydrated[0].text && entry.images.length === hydrated[0].images.length));
      if (hydrated.length && !duplicate) session.messages = [...session.messages, ...hydrated];
    } else {
      upsertActivity(session, item, method === "item/completed" ? "completed" : "inProgress");
      upsertSubagentFromItem(session, item);
    }
  } else if (method === "item/commandExecution/outputDelta") {
    const itemId = stringValue(params.itemId);
    const delta = stringValue(params.delta);
    if (session.activities.some((entry) => entry.id === itemId)) {
        const current = session.activities.find((entry) => entry.id === itemId);
        const output = appendActivityText(current?.output ?? "", delta, ACTIVITY_OUTPUT_LIMIT);
        if (current && output !== current.output) {
          session.activities = session.activities.map((entry) => entry.id === itemId ? { ...entry, output } : entry);
        }
    }
  } else if (method === "item/fileChange/outputDelta" || method === "item/fileChange/patchUpdated" || method === "item/mcpToolCall/progress" || method === "item/reasoning/summaryTextDelta") {
    const itemId = stringValue(params.itemId);
    const delta = stringValue(params.delta, stringValue(params.patch, stringValue(params.message)));
    const existing = session.activities.find((entry) => entry.id === itemId);
    if (existing) {
      const output = appendActivityText(existing.output ?? "", delta, ACTIVITY_OUTPUT_LIMIT);
      const detail = method.includes("reasoning") ? limitActivityText(`${existing.detail}${delta}`, ACTIVITY_DETAIL_LIMIT) : existing.detail;
      if (output !== existing.output || detail !== existing.detail) {
        session.activities = session.activities.map((entry) => entry.id === itemId ? { ...entry, output, detail } : entry);
      }
    } else if (itemId) {
      session.activities = [...session.activities, {
        id: itemId,
        kind: method.includes("fileChange") ? "fileChange" : method.includes("mcpToolCall") ? "mcpToolCall" : "reasoning",
        title: method.includes("fileChange") ? "文件修改" : method.includes("mcpToolCall") ? "工具调用" : "思考摘要",
        detail: limitActivityText(delta || "进行中", ACTIVITY_DETAIL_LIMIT), output: limitActivityText(delta, ACTIVITY_OUTPUT_LIMIT), status: "inProgress", visibleInMain: false,
      }];
    }
  } else if (method === "turn/diff/updated") {
    const diff = stringValue(params.diff);
    const id = `diff-${stringValue(params.turnId, "current")}`;
    const existing = session.activities.find((entry) => entry.id === id);
    const activity: Activity = { id, kind: "fileChange", title: "工作区 Diff", detail: "当前 Turn 的文件差异", output: limitActivityText(diff, ACTIVITY_OUTPUT_LIMIT), status: "inProgress", visibleInMain: false };
    session.activities = existing
      ? session.activities.map((entry) => entry.id === id ? activity : entry)
      : [...session.activities, activity];
  } else if (method === "thread/tokenUsage/updated") {
    const usage = asRecord(params.tokenUsage);
    const last = asRecord(usage.last);
    session.tokenUsage = { used: numberValue(last.totalTokens), total: typeof usage.modelContextWindow === "number" ? usage.modelContextWindow : null };
  } else if (method === "thread/settings/updated") {
    const settings = asRecord(params.threadSettings);
    session.model = stringValue(settings.model, session.model);
    session.effort = stringValue(settings.effort, session.effort);
  } else if (method === "serverRequest/resolved") {
    const requestId = asRecord(params).requestId ?? asRecord(params).request_id;
    if (typeof requestId === "string" || typeof requestId === "number") {
      session.pendingApprovals = session.pendingApprovals.filter((approval) => approval.requestId !== requestId);
    }
  } else if (message.error) {
    session.status = "error";
    session.statusLabel = "执行失败";
    session.activeTurnId = null;
    session.startedAt = null;
    session.retryState = null;
    session.errorText = message.error.message;
    if (session.messages.some((entry) => entry.streaming)) {
      session.messages = session.messages.map((entry) => entry.streaming ? { ...entry, streaming: false } : entry);
    }
  }
  return { session: enforceSessionBudgets(session), approval: pendingRequestFromMessage(message), ignored: false };
}

/** 子 Agent 线程事件只更新父会话的 Agent 面板，不混入主对话消息流。 */
export function applySubagentMessage(source: SessionState, message: JsonRpcMessage, threadId: string): SessionState {
  const session = { ...source };
  const params = asRecord(message.params);
  const method = message.method || "";
  if (method === "thread/started") {
    const thread = asRecord(params.thread);
    const spawn = asRecord(asRecord(asRecord(thread.source).subAgent).thread_spawn);
    updateSubagentState(session, threadId, {
      nickname: stringValue(thread.agentNickname, stringValue(spawn.agent_nickname, "子 Agent")), role: stringValue(thread.agentRole, stringValue(spawn.agent_role)), status: "running",
    });
  } else if (method === "turn/started") {
    updateSubagentState(session, threadId, { status: "running" });
  } else if (method === "turn/completed") {
    const status = stringValue(asRecord(params.turn).status);
    updateSubagentState(session, threadId, { status: status === "interrupted" ? "interrupted" : status === "failed" ? "errored" : "completed" });
  } else if (method === "item/agentMessage/delta") {
    const current = session.subagents.find((entry) => entry.threadId === threadId);
    updateSubagentState(session, threadId, { status: "running", message: `${current?.message || ""}${stringValue(params.delta)}` });
  } else if (method === "item/completed") {
    const item = asRecord(params.item);
    if (item.type === "agentMessage") updateSubagentState(session, threadId, { message: stringValue(item.text), status: "running" });
  }
  return session;
}

export function normalizeModel(value: unknown) {
  const model = asRecord(value);
  const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map((entry) => stringValue(asRecord(entry).reasoningEffort)).filter(Boolean) : [];
  return {
    id: stringValue(model.id, stringValue(model.model)), displayName: stringValue(model.displayName, stringValue(model.model, "模型")), description: stringValue(model.description),
    efforts, defaultEffort: stringValue(model.defaultReasoningEffort, efforts[0] || "medium"), supportsImage: Array.isArray(model.inputModalities) && model.inputModalities.includes("image"),
  };
}
