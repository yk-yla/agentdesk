import { useCallback, useSyncExternalStore } from "react";

export interface RawEvent {
  id: string;
  label: string;
  payload: unknown;
  createdAt: number;
}

export interface RawEventStoreStats {
  sessionCount: number;
  eventCount: number;
  estimatedBytes: number;
  compactedEvents: number;
  trimmedEvents: number;
  trimmedBytes: number;
}

const NOTIFY_INTERVAL_MS = 250;
const MAX_EVENTS_PER_SESSION = 20_000;
const TRIM_TO_EVENTS = 18_000;
const MAX_EVENT_PAYLOAD_BYTES = 1024 * 1024;
const COMPACTED_PAYLOAD_BYTES = 64 * 1024;
const MAX_BYTES_PER_SESSION = 16 * 1024 * 1024;
const TRIM_TO_BYTES_PER_SESSION = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const TRIM_TO_TOTAL_BYTES = 56 * 1024 * 1024;
const EMPTY: RawEvent[] = [];

interface Bucket {
  live: RawEvent[];
  liveBytes: number;
  snapshot: RawEvent[];
  snapshotVersion: number;
}

interface CompactState {
  remaining: number;
  truncated: boolean;
  seen: WeakSet<object>;
}

const buckets = new Map<string, Bucket>();
const payloadCache = new WeakMap<RawEvent, string>();
const eventSizes = new WeakMap<RawEvent, number>();
const listeners = new Set<() => void>();
let version = 0;
let notifyTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let sequence = 0;
let totalEventBytes = 0;
let compactedEvents = 0;
let trimmedEvents = 0;
let trimmedBytes = 0;

function estimateValueBytes(value: unknown, limit: number, seen = new WeakSet<object>(), depth = 0): number {
  if (limit <= 0 || value === null || value === undefined) return 0;
  if (typeof value === "string") return Math.min(limit, value.length * 2);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return Math.min(limit, 16);
  if (typeof value !== "object") return Math.min(limit, 32);
  if (seen.has(value)) return Math.min(limit, 16);
  if (depth >= 12) return Math.min(limit, 64);
  seen.add(value);
  let bytes = 64;
  for (const [key, child] of Object.entries(value)) {
    bytes += key.length * 2 + 16;
    if (bytes >= limit) return limit;
    bytes += estimateValueBytes(child, limit - bytes, seen, depth + 1);
    if (bytes >= limit) return limit;
  }
  return bytes;
}

function compactValue(value: unknown, state: CompactState, depth = 0): unknown {
  if (state.remaining <= 0) {
    state.truncated = true;
    return "[已省略]";
  }
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    state.remaining -= 16;
    return value;
  }
  if (typeof value === "string") {
    const maxCharacters = Math.max(0, Math.floor(state.remaining / 2));
    if (value.length <= maxCharacters) {
      state.remaining -= value.length * 2;
      return value;
    }
    state.remaining = 0;
    state.truncated = true;
    return `${value.slice(0, Math.max(0, maxCharacters - 1))}…`;
  }
  if (typeof value !== "object") {
    state.remaining -= 32;
    return String(value);
  }
  if (state.seen.has(value)) return "[循环引用]";
  if (depth >= 8) {
    state.truncated = true;
    return "[已省略深层对象]";
  }
  state.seen.add(value);
  state.remaining -= 64;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (state.remaining <= 64) {
        state.truncated = true;
        result.push(`[已省略 ${value.length - index} 项]`);
        break;
      }
      result.push(compactValue(value[index], state, depth + 1));
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (let index = 0; index < entries.length; index += 1) {
    const [key, child] = entries[index];
    const keyBytes = key.length * 2 + 16;
    if (state.remaining <= keyBytes + 64) {
      state.truncated = true;
      result.__truncatedFields = entries.length - index;
      break;
    }
    state.remaining -= keyBytes;
    result[key] = compactValue(child, state, depth + 1);
  }
  return result;
}

function retainedPayload(payload: unknown) {
  const estimatedBytes = estimateValueBytes(payload, MAX_EVENT_PAYLOAD_BYTES + 1);
  if (estimatedBytes <= MAX_EVENT_PAYLOAD_BYTES) return { payload, estimatedBytes };
  const state: CompactState = { remaining: COMPACTED_PAYLOAD_BYTES, truncated: false, seen: new WeakSet<object>() };
  const preview = compactValue(payload, state);
  compactedEvents += 1;
  return {
    payload: {
      truncated: true,
      reason: "原始事件过大，已按内存上限保留摘要。",
      originalBytesAtLeast: estimatedBytes,
      preview,
    },
    estimatedBytes: estimateValueBytes(preview, COMPACTED_PAYLOAD_BYTES) + 256,
  };
}

function createRawEvent(label: string, payload: unknown) {
  const retained = retainedPayload(payload);
  const event: RawEvent = {
    id: `raw-${(sequence += 1)}`,
    label: label || "event",
    payload: retained.payload,
    createdAt: Date.now(),
  };
  eventSizes.set(event, retained.estimatedBytes + event.label.length * 2 + 128);
  return event;
}

function eventSize(event: RawEvent) {
  return eventSizes.get(event) ?? 128;
}

function addEvent(bucket: Bucket, event: RawEvent, prepend = false) {
  if (prepend) bucket.live.unshift(event);
  else bucket.live.push(event);
  const bytes = eventSize(event);
  bucket.liveBytes += bytes;
  totalEventBytes += bytes;
  bucket.snapshotVersion = -1;
}

function removeFirstEvent(bucket: Bucket) {
  const removed = bucket.live.shift();
  if (!removed) return 0;
  const bytes = eventSize(removed);
  bucket.liveBytes = Math.max(0, bucket.liveBytes - bytes);
  totalEventBytes = Math.max(0, totalEventBytes - bytes);
  bucket.snapshotVersion = -1;
  return bytes;
}

function addTrimMarker(bucket: Bucket, removed: number, removedBytes: number) {
  if (!removed) return;
  trimmedEvents += removed;
  trimmedBytes += removedBytes;
  addEvent(bucket, createRawEvent("client/events-trimmed", {
    removed,
    removedBytes,
    message: "较早的原始事件已按内存上限清理。",
  }), true);
}

function enforceSessionBudget(bucket: Bucket) {
  if (bucket.live.length <= MAX_EVENTS_PER_SESSION && bucket.liveBytes <= MAX_BYTES_PER_SESSION) return;
  let removed = 0;
  let removedBytes = 0;
  while (bucket.live.length > TRIM_TO_EVENTS || bucket.liveBytes > TRIM_TO_BYTES_PER_SESSION) {
    const bytes = removeFirstEvent(bucket);
    if (!bytes) break;
    removed += 1;
    removedBytes += bytes;
  }
  addTrimMarker(bucket, removed, removedBytes);
}

function enforceGlobalBudget() {
  if (totalEventBytes <= MAX_TOTAL_BYTES) return;
  const removedBySession = new Map<string, { count: number; bytes: number }>();
  while (totalEventBytes > TRIM_TO_TOTAL_BYTES) {
    let oldestSessionId = "";
    let oldestBucket: Bucket | undefined;
    for (const [sessionId, bucket] of buckets) {
      if (!bucket.live.length) continue;
      if (!oldestBucket || bucket.live[0].createdAt < oldestBucket.live[0].createdAt) {
        oldestSessionId = sessionId;
        oldestBucket = bucket;
      }
    }
    if (!oldestBucket) break;
    const bytes = removeFirstEvent(oldestBucket);
    if (!bytes) break;
    const removed = removedBySession.get(oldestSessionId) || { count: 0, bytes: 0 };
    removed.count += 1;
    removed.bytes += bytes;
    removedBySession.set(oldestSessionId, removed);
  }
  for (const [sessionId, removed] of removedBySession) {
    const bucket = buckets.get(sessionId);
    if (bucket) addTrimMarker(bucket, removed.count, removed.bytes);
  }
}

function scheduleNotify() {
  if (notifyTimer !== null) return;
  notifyTimer = globalThis.setTimeout(() => {
    notifyTimer = null;
    version += 1;
    listeners.forEach((listener) => listener());
  }, NOTIFY_INTERVAL_MS);
}

/** 原始事件按会话和全局字节预算保存在 React 状态之外，避免大载荷长期占用 Renderer 堆。 */
export function appendRawEvent(sessionId: string, label: string, payload: unknown) {
  const event = createRawEvent(label, payload);
  let bucket = buckets.get(sessionId);
  if (!bucket) {
    bucket = { live: [], liveBytes: 0, snapshot: EMPTY, snapshotVersion: -1 };
    buckets.set(sessionId, bucket);
  }
  addEvent(bucket, event);
  enforceSessionBudget(bucket);
  enforceGlobalBudget();
  scheduleNotify();
}

export function rawEventSnapshot(sessionId: string): RawEvent[] {
  const bucket = buckets.get(sessionId);
  if (!bucket) return EMPTY;
  if (bucket.snapshotVersion !== version || bucket.snapshot.length !== bucket.live.length) {
    bucket.snapshotVersion = version;
    bucket.snapshot = bucket.live.slice();
  }
  return bucket.snapshot;
}

export function rawEventCount(sessionId: string) {
  return buckets.get(sessionId)?.live.length ?? 0;
}

export function rawEventStoreStats(): RawEventStoreStats {
  let eventCount = 0;
  for (const bucket of buckets.values()) eventCount += bucket.live.length;
  return {
    sessionCount: buckets.size,
    eventCount,
    estimatedBytes: totalEventBytes,
    compactedEvents,
    trimmedEvents,
    trimmedBytes,
  };
}

export function clearRawEvents(sessionId: string) {
  const bucket = buckets.get(sessionId);
  if (!bucket) return;
  totalEventBytes = Math.max(0, totalEventBytes - bucket.liveBytes);
  buckets.delete(sessionId);
  scheduleNotify();
}

/** 序列化按需进行：不打开原始事件视图就不会付出 JSON.stringify 的成本。 */
export function rawEventText(event: RawEvent) {
  const cached = payloadCache.get(event);
  if (cached !== undefined) return cached;
  let text: string;
  try {
    text = JSON.stringify(event.payload ?? {}) ?? "";
  } catch {
    text = "[无法序列化的事件]";
  }
  payloadCache.set(event, text);
  return text;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function useRawEvents(sessionId: string): RawEvent[] {
  const getSnapshot = useCallback(() => rawEventSnapshot(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
