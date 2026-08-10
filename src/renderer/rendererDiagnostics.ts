import type { AgentBridge, ClientLogEntry, JsonObject } from "../shared/protocol";

function emit(bridge: AgentBridge, entry: ClientLogEntry) {
  void bridge.writeLog(entry).catch(() => undefined);
}

function elementDetails(target: EventTarget | null): JsonObject {
  if (!(target instanceof Element)) return { targetType: typeof target };
  const actionable = target.closest("button,a,input,textarea,select,[role=button],[role=tab],[role=menuitem]") || target;
  const ariaLabel = actionable.getAttribute("aria-label") || "";
  const title = actionable.getAttribute("title") || "";
  const label = ariaLabel || title;
  return {
    tag: actionable.tagName.toLowerCase(),
    id: actionable.id || undefined,
    className: typeof actionable.className === "string" ? actionable.className.slice(0, 240) : undefined,
    role: actionable.getAttribute("role") || undefined,
    labelLength: label.length,
    labelSource: ariaLabel ? "aria-label" : title ? "title" : undefined,
    textLength: (actionable.textContent || "").trim().length,
    disabled: actionable instanceof HTMLButtonElement || actionable instanceof HTMLInputElement ? actionable.disabled : false,
  };
}

export function installRendererDiagnostics(bridge: AgentBridge) {
  const onClick = (event: MouseEvent) => emit(bridge, { level: "info", event: "ui.click", details: { ...elementDetails(event.target), button: event.button } });
  const onChange = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    emit(bridge, { level: "info", event: "ui.change", details: { ...elementDetails(target), inputType: target instanceof HTMLInputElement ? target.type : target.tagName.toLowerCase(), valueLength: target.value.length } });
  };
  const onError = (event: ErrorEvent) => emit(bridge, { level: "error", event: "renderer.error", details: { message: event.message, filename: event.filename, line: event.lineno, column: event.colno, error: event.error instanceof Error ? { name: event.error.name, message: event.error.message, stack: event.error.stack } : undefined } });
  const onUnhandledRejection = (event: PromiseRejectionEvent) => emit(bridge, { level: "error", event: "renderer.unhandled_rejection", details: { reason: event.reason instanceof Error ? { name: event.reason.name, message: event.reason.message, stack: event.reason.stack } : { message: String(event.reason) } } });
  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  emit(bridge, { level: "info", event: "renderer.ready", details: { url: location.pathname, userAgent: navigator.userAgent } });
  return () => {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("change", onChange, true);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
