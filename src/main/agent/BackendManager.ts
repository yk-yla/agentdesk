import type { AgentBackend } from "./AgentBackend";
import type { AgentEventEnvelope, AgentOperation, AgentProvider, AgentRequestContext, InteractionRef } from "../../shared/agentProtocol";
import type { JsonObject } from "../../shared/protocol";
import type { AppLogger } from "../logger";
import { logErrorDetails } from "../logger";
import { AgentSessionRegistry } from "./agentSessionRegistry";
import { NativeSessionOwnershipRegistry } from "./nativeSessionOwnershipRegistry";

export class BackendManager {
  private readonly backends = new Map<AgentProvider, AgentBackend>();
  private readonly listeners = new Set<(event: AgentEventEnvelope) => void>();
  private readonly subscriptions = new Map<AgentProvider, () => void>();
  private closePromise: Promise<void> | null = null;
  private readonly sessions: AgentSessionRegistry;

  constructor(private readonly logger?: AppLogger, isWorkspaceAuthorized?: (cwd: string) => boolean, nativeOwnership?: NativeSessionOwnershipRegistry) {
    this.sessions = new AgentSessionRegistry(isWorkspaceAuthorized, nativeOwnership);
  }

  register(backend: AgentBackend) {
    if (this.backends.has(backend.provider)) throw new Error(`Provider 已注册：${backend.provider}`);
    this.backends.set(backend.provider, backend);
    this.subscriptions.set(backend.provider, backend.subscribeEvents((event) => {
      if (event.provider !== backend.provider) return;
      const routedEvent = this.sessions.observeEvent(event);
      this.logger?.log("debug", "provider.event", { provider: backend.provider, type: routedEvent.type, requestId: routedEvent.requestId, payload: routedEvent.payload });
      this.listeners.forEach((listener) => listener(routedEvent));
    }));
  }

  has(provider: AgentProvider) {
    return this.backends.has(provider);
  }

  async request(provider: AgentProvider, operation: AgentOperation, params: JsonObject = {}, context: AgentRequestContext = {}) {
    const requestId = context.requestId || `${provider}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    try {
      const backend = this.require(provider);
      const preparation = this.sessions.prepareRequest(provider, operation, params, context);
      let result: unknown;
      if (preparation?.skipBackend) result = undefined;
      else if (operation === "getCapabilities") result = await backend.getCapabilities();
      else if (operation === "closeSession") result = await backend.closeSession(context);
      else result = await backend.request(operation, params, context);
      this.sessions.completeRequest(provider, operation, params, context, result);
      this.logger?.log("info", "provider.request.completed", { requestId, provider, operation, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      this.sessions.failRequest(provider, operation, context, error);
      this.logger?.log("error", "provider.request.failed", { requestId, provider, operation, durationMs: Date.now() - startedAt, error: logErrorDetails(error) });
      throw error;
    }
  }

  respond(ref: InteractionRef, result: JsonObject) {
    this.sessions.prepareResponse(ref);
    return this.require(ref.provider).respondToInteraction(ref, result).then((value) => {
      this.sessions.completeResponse(ref, true);
      return value;
    }, (error) => {
      this.sessions.completeResponse(ref, false);
      throw error;
    });
  }

  subscribeEvents(listener: (event: AgentEventEnvelope) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      const results = await Promise.allSettled([...this.backends.values()].map((backend) => backend.close()));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new Error(`关闭 Provider 失败：${failures.map((failure) => failure.reason instanceof Error ? failure.reason.message : String(failure.reason)).join("；")}`);
      this.subscriptions.forEach((unsubscribe) => unsubscribe());
      this.subscriptions.clear();
      this.sessions.clearProvider("codex");
      this.sessions.clearProvider("claude");
    })().catch((error) => {
      this.closePromise = null;
      throw error;
    });
    return this.closePromise;
  }

  async resetRendererSessions() {
    const registrations = this.sessions.rendererSessions();
    const failures: unknown[] = [];
    this.sessions.clearRendererSessions();
    await Promise.all(registrations.map(async ({ provider, context, queryActive }) => {
      const backend = this.backends.get(provider);
      if (!backend) return;
      if (queryActive && context.nativeSessionId) {
        try {
          await backend.request("interruptTurn", { threadId: context.nativeSessionId }, context);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await (backend.resetSession?.(context) ?? backend.closeSession(context));
      } catch (error) {
        failures.push(error);
      }
    }));
    if (failures.length) this.logger?.log("warn", "provider.renderer_session_reset_partial", { count: failures.length });
    return { reset: registrations.length, failures: failures.length };
  }

  assertNativeSessionAuthorized(provider: AgentProvider, nativeSessionId: string, cwd: string) {
    this.sessions.assertNativeSessionAuthorized(provider, nativeSessionId, cwd);
  }

  async prepareTerminalSession(provider: AgentProvider, context: AgentRequestContext) {
    if (!context.nativeSessionId) return;
    this.sessions.assertNativeSessionAuthorized(provider, context.nativeSessionId, context.canonicalCwd || "");
    const activeWork = this.sessions.rendererSessions().some((registration) => registration.provider === provider && registration.queryActive);
    if (activeWork) throw new Error(`${provider === "codex" ? "Codex" : "Claude Code"} 还有任务正在运行，完成或停止后才能切换黑窗口。`);
    await this.require(provider).prepareTerminalSession?.(context);
    // Release only the handoff target. Other idle workbench tabs remain
    // registered and can be resumed after the shared runtime restarts.
    this.sessions.releaseRendererSession(context.sessionId || "");
  }

  private require(provider: AgentProvider) {
    const backend = this.backends.get(provider);
    if (!backend) throw new Error(`Provider 暂不可用：${provider}`);
    return backend;
  }
}
