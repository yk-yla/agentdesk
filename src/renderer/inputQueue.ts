import { decodeCodexRpcError, type CodexRpcErrorPayload, type JsonObject, type JsonRpcMessage } from "../shared/protocol";
import { asRecord, stringValue, type PendingSteerMessage, type QueuedMessage } from "./domain";

export class CodexRequestError extends Error {
  readonly payload: CodexRpcErrorPayload;

  constructor(payload: CodexRpcErrorPayload) {
    super(payload.message);
    this.name = "CodexRequestError";
    this.payload = payload;
  }
}

export function normalizeCodexRequestError(error: unknown, method: string): Error {
  if (error instanceof CodexRequestError) return error;
  const payload = decodeCodexRpcError(error);
  return payload ? new CodexRequestError(payload) : error instanceof Error ? error : new Error(`${method} 请求失败`);
}

function requestPayload(error: unknown): CodexRpcErrorPayload | null {
  return error instanceof CodexRequestError ? error.payload : decodeCodexRpcError(error);
}

export function codexRequestMethod(error: unknown) {
  return requestPayload(error)?.method || "";
}

export function isCodexRequestTimeout(error: unknown) {
  return stringValue(asRecord(requestPayload(error)?.data).kind) === "requestTimeout";
}

export function isCodexActiveWriterConflict(error: unknown) {
  const payload = requestPayload(error);
  const message = payload?.message || (error instanceof Error ? error.message : String(error));
  return /already has an active writer/i.test(message);
}

export function inputForMessage(message: Pick<QueuedMessage, "text" | "inputText" | "images" | "skills">): JsonObject[] {
  const input: JsonObject[] = [];
  // Skill 输入统一走普通文本，让 Codex 自己按 `$skill-name` 解析 Skill。
  // 保留旧队列中结构化 Skill 的兼容转换，避免恢复历史队列时再次发送路径对象。
  const skillPrefix = message.skills?.map((skill) => skill.name.trim()).filter(Boolean).map((name) => `$${name}`).join(" ") || "";
  const text = message.skills?.length
    ? [skillPrefix, message.inputText?.trim() || ""].filter(Boolean).join(" ")
    : message.inputText ?? message.text;
  if (text) input.push({ type: "text", text, text_elements: [] });
  message.images.forEach((image) => input.push({ type: "localImage", path: image.path }));
  return input;
}

export function actualTurnIdFromMismatch(error: unknown): string | null {
  const message = requestPayload(error)?.message || (error instanceof Error ? error.message : "");
  const match = message.match(/^expected active turn id `([^`]+)` but found `([^`]+)`$/);
  return match?.[2] || null;
}

export function actualTurnIdFromInterruptMismatch(error: unknown): string | null {
  const message = requestPayload(error)?.message || (error instanceof Error ? error.message : "");
  const match = message.match(/^expected active turn id (.+) but found (.+)$/);
  return match?.[2] || null;
}

export function isMissingActiveTurn(error: unknown) {
  const message = requestPayload(error)?.message || (error instanceof Error ? error.message : "");
  return message === "no active turn to steer";
}

export function isNonSteerableTurn(error: unknown) {
  const payload = requestPayload(error);
  const data = asRecord(payload?.data);
  const info = asRecord(data.codexErrorInfo ?? data.codex_error_info);
  const kind = stringValue(info.type, stringValue(info.kind));
  return kind === "activeTurnNotSteerable"
    || kind === "active_turn_not_steerable"
    || /^cannot steer a (review|compact) turn$/.test(payload?.message || "");
}

export function clientIdFromUserMessage(message: JsonRpcMessage): string | null {
  if (message.method !== "item/started" && message.method !== "item/completed") return null;
  const item = asRecord(asRecord(message.params).item);
  if (item.type !== "userMessage") return null;
  return stringValue(item.clientId, stringValue(item.client_id)) || null;
}

export function insertRejectedSteer(queue: QueuedMessage[], steer: PendingSteerMessage): QueuedMessage[] {
  const rejected: QueuedMessage = { ...steer, queueKind: "rejectedSteer" };
  const next = [...queue, rejected];
  return next.sort((left, right) => {
    const leftPriority = left.queueKind === "rejectedSteer" ? 0 : 1;
    const rightPriority = right.queueKind === "rejectedSteer" ? 0 : 1;
    return leftPriority - rightPriority || (left.sequence || 0) - (right.sequence || 0);
  });
}

export function mergeMessages(messages: QueuedMessage[]): QueuedMessage {
  return {
    id: `merged-${Date.now()}`,
    text: messages.map((message) => message.text).filter(Boolean).join("\n"),
    inputText: messages.map((message) => message.inputText ?? message.text).filter(Boolean).join("\n"),
    images: messages.flatMap((message) => message.images),
    skills: messages.flatMap((message) => message.skills || []),
    sequence: Math.min(...messages.map((message) => message.sequence || Date.now())),
  };
}
