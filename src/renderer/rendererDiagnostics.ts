import type { AgentBridge, ClientLogEntry, JsonObject } from "../shared/protocol";
import { rawEventStoreStats } from "./rawEventStore";

const UI_EVENT_NAME = "agentdesk:ui-event";
const EVENT_LOOP_INTERVAL_MS = 1_000;
const EVENT_LOOP_STALL_MS = 200;
const MEMORY_SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const rendererInstanceId = globalThis.crypto?.randomUUID?.() || `renderer-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export function trackUiEvent(event: string, details: JsonObject = {}) {
  window.dispatchEvent(new CustomEvent(UI_EVENT_NAME, { detail: { event, details } }));
}

function emit(bridge: AgentBridge, entry: ClientLogEntry) {
  void bridge.writeLog({ ...entry, details: { ...entry.details, rendererInstanceId } }).catch(() => undefined);
}

function elementKind(value: Element | null) {
  if (!value) return "none";
  const role = value.getAttribute("role");
  const inputType = value instanceof HTMLInputElement ? value.type : "";
  const className = typeof value.className === "string" ? value.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
  return [value.tagName.toLowerCase(), role ? `role:${role}` : "", inputType ? `type:${inputType}` : "", className ? `class:${className}` : ""]
    .filter(Boolean)
    .join("|");
}

function interactionState() {
  return {
    focused: document.hasFocus(),
    visibility: document.visibilityState,
    activeElement: elementKind(document.activeElement),
    bodyClasses: Array.from(document.body.classList).filter((name) => name.startsWith("resizing-") || name.startsWith("dragging-")),
    modalCount: document.querySelectorAll('[aria-modal="true"], .dialog-backdrop, .image-lightbox').length,
    openMenuCount: document.querySelectorAll('[role="menu"], details[open], .command-suggestions').length,
  };
}

function rendererMemorySnapshot() {
  const rawEvents = rawEventStoreStats();
  // Chromium exposes performance.memory at runtime, but it is not part of the
  // cross-browser Performance type used by TypeScript's DOM declarations.
  const runtimePerformance = performance as Performance & {
    memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
  };
  const memory = runtimePerformance.memory;
  return {
    rawEventSessions: rawEvents.sessionCount,
    rawEventCount: rawEvents.eventCount,
    rawEventEstimatedBytes: rawEvents.estimatedBytes,
    rawEventCompacted: rawEvents.compactedEvents,
    rawEventTrimmed: rawEvents.trimmedEvents,
    ...(memory
      ? {
        usedJSHeapBytes: memory.usedJSHeapSize || 0,
        totalJSHeapBytes: memory.totalJSHeapSize || 0,
        jsHeapLimitBytes: memory.jsHeapSizeLimit || 0,
      }
      : {}),
  };
}

export class EventLoopLagTracker {
  private expectedTick: number;

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.expectedTick = this.now() + this.intervalMs;
  }

  reset() {
    this.expectedTick = this.now() + this.intervalMs;
  }

  sample(visible: boolean) {
    const current = this.now();
    const lagMs = Math.max(0, Math.round(current - this.expectedTick));
    this.expectedTick = current + this.intervalMs;
    return visible ? lagMs : null;
  }
}

export function installRendererDiagnostics(bridge: AgentBridge) {
  const onUiEvent = (event: Event) => {
    const detail = (event as CustomEvent<{ event?: unknown; details?: unknown }>).detail;
    if (!detail || typeof detail.event !== "string" || !detail.event.trim()) return;
    emit(bridge, { level: "info", event: `ui.${detail.event.trim()}`, details: detail.details && typeof detail.details === "object" && !Array.isArray(detail.details) ? detail.details as JsonObject : {} });
  };
  const onError = (event: ErrorEvent) => emit(bridge, { level: "error", event: "renderer.error", details: { message: event.message, filename: event.filename, line: event.lineno, column: event.colno, error: event.error instanceof Error ? { name: event.error.name, message: event.error.message, stack: event.error.stack } : undefined } });
  const onUnhandledRejection = (event: PromiseRejectionEvent) => emit(bridge, { level: "error", event: "renderer.unhandled_rejection", details: { reason: event.reason instanceof Error ? { name: event.reason.name, message: event.reason.message, stack: event.reason.stack } : { message: String(event.reason) } } });
  const eventLoopLag = new EventLoopLagTracker(EVENT_LOOP_INTERVAL_MS);
  const onFocus = () => {
    eventLoopLag.reset();
    emit(bridge, { event: "renderer.window.focus", details: interactionState() });
  };
  const onBlur = () => emit(bridge, { event: "renderer.window.blur", details: interactionState() });
  const onVisibility = () => {
    eventLoopLag.reset();
    emit(bridge, { event: "renderer.visibility.changed", details: interactionState() });
  };
  const onPageShow = (event: PageTransitionEvent) => {
    eventLoopLag.reset();
    emit(bridge, { event: "renderer.page.shown", details: { persisted: event.persisted, ...interactionState() } });
  };
  const onPageHide = (event: PageTransitionEvent) => emit(bridge, { event: "renderer.page.hidden", details: { persisted: event.persisted, ...interactionState() } });
  window.addEventListener(UI_EVENT_NAME, onUiEvent);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);
  const stallTimer = window.setInterval(() => {
    const lagMs = eventLoopLag.sample(document.visibilityState === "visible");
    if (lagMs !== null && lagMs >= EVENT_LOOP_STALL_MS) {
      emit(bridge, { level: "warn", event: "renderer.event_loop.stall", details: { lagMs, ...interactionState() } });
    }
  }, EVENT_LOOP_INTERVAL_MS);
  const emitMemorySnapshot = () => {
    if (document.visibilityState === "visible") emit(bridge, { level: "info", event: "renderer.memory.snapshot", details: rendererMemorySnapshot() });
  };
  const memoryTimer = window.setInterval(emitMemorySnapshot, MEMORY_SNAPSHOT_INTERVAL_MS);
  emitMemorySnapshot();
  emit(bridge, { level: "info", event: "renderer.ready", details: { url: location.pathname, userAgent: navigator.userAgent, width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio, ...interactionState() } });
  return () => {
    window.clearInterval(stallTimer);
    window.clearInterval(memoryTimer);
    window.removeEventListener(UI_EVENT_NAME, onUiEvent);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
