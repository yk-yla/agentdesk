import type { AgentBridge, ClientLogEntry, JsonObject } from "../shared/protocol";

const UI_EVENT_NAME = "agentdesk:ui-event";

export function trackUiEvent(event: string, details: JsonObject = {}) {
  window.dispatchEvent(new CustomEvent(UI_EVENT_NAME, { detail: { event, details } }));
}

function emit(bridge: AgentBridge, entry: ClientLogEntry) {
  void bridge.writeLog(entry).catch(() => undefined);
}

export function installRendererDiagnostics(bridge: AgentBridge) {
  const onUiEvent = (event: Event) => {
    const detail = (event as CustomEvent<{ event?: unknown; details?: unknown }>).detail;
    if (!detail || typeof detail.event !== "string" || !detail.event.trim()) return;
    emit(bridge, { level: "info", event: `ui.${detail.event.trim()}`, details: detail.details && typeof detail.details === "object" && !Array.isArray(detail.details) ? detail.details as JsonObject : {} });
  };
  const onError = (event: ErrorEvent) => emit(bridge, { level: "error", event: "renderer.error", details: { message: event.message, filename: event.filename, line: event.lineno, column: event.colno, error: event.error instanceof Error ? { name: event.error.name, message: event.error.message, stack: event.error.stack } : undefined } });
  const onUnhandledRejection = (event: PromiseRejectionEvent) => emit(bridge, { level: "error", event: "renderer.unhandled_rejection", details: { reason: event.reason instanceof Error ? { name: event.reason.name, message: event.reason.message, stack: event.reason.stack } : { message: String(event.reason) } } });
  window.addEventListener(UI_EVENT_NAME, onUiEvent);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  emit(bridge, { level: "info", event: "renderer.ready", details: { url: location.pathname, userAgent: navigator.userAgent } });
  return () => {
    window.removeEventListener(UI_EVENT_NAME, onUiEvent);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
