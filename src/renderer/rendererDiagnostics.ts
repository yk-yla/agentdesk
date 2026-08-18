import type { AgentBridge, ClientLogEntry, JsonObject } from "../shared/protocol";

const UI_EVENT_NAME = "agentdesk:ui-event";
const EVENT_LOOP_INTERVAL_MS = 5_000;
const EVENT_LOOP_STALL_MS = 1_000;
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
    bodyClasses: [...document.body.classList].filter((name) => name.startsWith("resizing-") || name.startsWith("dragging-")),
    modalCount: document.querySelectorAll('[aria-modal="true"], .dialog-backdrop, .plugin-overlay, .image-lightbox').length,
    openMenuCount: document.querySelectorAll('[role="menu"], details[open], .command-suggestions').length,
  };
}

export function installRendererDiagnostics(bridge: AgentBridge) {
  const onUiEvent = (event: Event) => {
    const detail = (event as CustomEvent<{ event?: unknown; details?: unknown }>).detail;
    if (!detail || typeof detail.event !== "string" || !detail.event.trim()) return;
    emit(bridge, { level: "info", event: `ui.${detail.event.trim()}`, details: detail.details && typeof detail.details === "object" && !Array.isArray(detail.details) ? detail.details as JsonObject : {} });
  };
  const onError = (event: ErrorEvent) => emit(bridge, { level: "error", event: "renderer.error", details: { message: event.message, filename: event.filename, line: event.lineno, column: event.colno, error: event.error instanceof Error ? { name: event.error.name, message: event.error.message, stack: event.error.stack } : undefined } });
  const onUnhandledRejection = (event: PromiseRejectionEvent) => emit(bridge, { level: "error", event: "renderer.unhandled_rejection", details: { reason: event.reason instanceof Error ? { name: event.reason.name, message: event.reason.message, stack: event.reason.stack } : { message: String(event.reason) } } });
  const onFocus = () => emit(bridge, { event: "renderer.window.focus", details: interactionState() });
  const onBlur = () => emit(bridge, { event: "renderer.window.blur", details: interactionState() });
  const onVisibility = () => emit(bridge, { event: "renderer.visibility.changed", details: interactionState() });
  const onPageShow = (event: PageTransitionEvent) => emit(bridge, { event: "renderer.page.shown", details: { persisted: event.persisted, ...interactionState() } });
  const onPageHide = (event: PageTransitionEvent) => emit(bridge, { event: "renderer.page.hidden", details: { persisted: event.persisted, ...interactionState() } });
  window.addEventListener(UI_EVENT_NAME, onUiEvent);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);
  let expectedTick = performance.now() + EVENT_LOOP_INTERVAL_MS;
  const stallTimer = window.setInterval(() => {
    const now = performance.now();
    const lagMs = Math.max(0, Math.round(now - expectedTick));
    expectedTick = now + EVENT_LOOP_INTERVAL_MS;
    if (lagMs >= EVENT_LOOP_STALL_MS) emit(bridge, { level: "warn", event: "renderer.event_loop.stall", details: { lagMs, ...interactionState() } });
  }, EVENT_LOOP_INTERVAL_MS);
  emit(bridge, { level: "info", event: "renderer.ready", details: { url: location.pathname, userAgent: navigator.userAgent, width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio, ...interactionState() } });
  return () => {
    window.clearInterval(stallTimer);
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
