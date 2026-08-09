import { useCallback, useSyncExternalStore } from "react";

export interface RawEvent {
  id: string;
  label: string;
  payload: unknown;
}

const NOTIFY_INTERVAL_MS = 250;
const MAX_EVENTS_PER_SESSION = 20_000;
const TRIM_TO_EVENTS = 18_000;
const EMPTY: RawEvent[] = [];

interface Bucket {
  live: RawEvent[];
  snapshot: RawEvent[];
  snapshotVersion: number;
}

const buckets = new Map<string, Bucket>();
const payloadCache = new WeakMap<RawEvent, string>();
const listeners = new Set<() => void>();
let version = 0;
let notifyTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let sequence = 0;

function scheduleNotify() {
  if (notifyTimer !== null) return;
  notifyTimer = globalThis.setTimeout(() => {
    notifyTimer = null;
    version += 1;
    listeners.forEach((listener) => listener());
  }, NOTIFY_INTERVAL_MS);
}

/** 原始事件按会话上限保存在 React 状态之外，避免每条事件复制并重渲染整个会话。 */
export function appendRawEvent(sessionId: string, label: string, payload: unknown) {
  const entry: RawEvent = { id: `raw-${(sequence += 1)}`, label: label || "event", payload };
  const bucket = buckets.get(sessionId);
  if (bucket) {
    bucket.live.push(entry);
    if (bucket.live.length > MAX_EVENTS_PER_SESSION) {
      const removed = bucket.live.length - TRIM_TO_EVENTS;
      bucket.live.splice(0, removed, {
        id: `raw-trimmed-${(sequence += 1)}`,
        label: "client/events-trimmed",
        payload: { removed, message: "较早的原始事件已按内存上限清理。" },
      });
      bucket.snapshotVersion = -1;
    }
  }
  else buckets.set(sessionId, { live: [entry], snapshot: EMPTY, snapshotVersion: -1 });
  scheduleNotify();
}

export function rawEventSnapshot(sessionId: string): RawEvent[] {
  const bucket = buckets.get(sessionId);
  if (!bucket) return EMPTY;
  if (bucket.snapshotVersion !== version) {
    bucket.snapshotVersion = version;
    // 事件只追加不修改，长度相等即内容相等，可以复用上一次快照的引用。
    if (bucket.snapshot.length !== bucket.live.length) bucket.snapshot = bucket.live.slice();
  }
  return bucket.snapshot;
}

export function rawEventCount(sessionId: string) {
  return buckets.get(sessionId)?.live.length ?? 0;
}

export function clearRawEvents(sessionId: string) {
  if (buckets.delete(sessionId)) scheduleNotify();
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
