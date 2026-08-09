import type { AgentEventEnvelope, AgentProvider } from "../shared/agentProtocol";
import {
  agentEventPayload,
  applyAgentEvent,
  applyAgentSubagentEvent,
  normalizeAgentModel,
  routeAgentEvent,
  type RoutedAgentEvent,
} from "./agent/AgentEventRouter";
import { asRecord, stringValue, type ModelOption, type SessionState } from "./domain";
import { notificationActivationTarget } from "./notificationActivation";

export function nativeSessionKey(provider: AgentProvider, nativeSessionId: string) {
  return `${provider}:${nativeSessionId}`;
}

export interface ProviderEventVersion {
  event: number;
  lifecycle: number;
}

export interface ProviderEventState {
  getSessions(): Record<string, SessionState>;
  updateSession(sessionId: string, updater: (current: SessionState) => SessionState): void;
  updateSessions(updater: (current: Record<string, SessionState>) => Record<string, SessionState>): void;
  getActiveSessionId(): string | undefined;
  getWorkspace(): string;
}

export interface ProviderEventRuntime {
  lifecycle: {
    rejectStart(sessionId: string, error: Error): void;
    resolveLateStart(sessionId: string, value: unknown, adopt: (value: unknown) => string): boolean;
  };
  messages: {
    commitPendingSteer(sessionId: string, clientUserMessageId: string): void;
    handleTurnCompleted(sessionId: string, turnStatus: string): void;
  };
  settings: {
    confirmed(sessionId: string, fallback: { model: string; effort: string }): { model: string; effort: string };
    hasPending(sessionId: string): boolean;
    setConfirmed(sessionId: string, settings: { model: string; effort: string }): void;
  };
}

export interface ProviderEventServices {
  setReady(): void;
  removeHistory(provider: AgentProvider, nativeSessionId: string): void;
  clearSession(sessionId: string): void;
  recoverProvider(provider: AgentProvider): void;
  closeActiveTab(): void;
  reloadSkills(): void;
  activateSession(sessionId: string): void;
  openWorkspace(workspace: string): void;
  adoptStartedThread(sessionId: string, value: unknown): string;
  loadSkills(sessionId: string, cwd: string, forceReload: boolean): void;
  updateProviderModels(provider: AgentProvider, models: ModelOption[]): void;
  rememberModelContextWindow(sessionId: string, event: RoutedAgentEvent): void;
  appendRawEvent(sessionId: string, type: string, value: unknown): void;
  showNotification(session: Pick<SessionState, "id" | "provider" | "title">): void;
  isDocumentFocused(): boolean;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  now?: () => number;
}

export interface ProviderEventControllerOptions {
  state: ProviderEventState;
  runtime: ProviderEventRuntime;
  services: ProviderEventServices;
}

export class ProviderEventController {
  private readonly threadSessions = new Map<string, string>();
  private readonly subagentParents = new Map<string, string>();
  private readonly pendingThreadStarts = new Map<string, { event: RoutedAgentEvent; receivedAt: number }>();
  private readonly versions = new Map<string, ProviderEventVersion>();
  private pendingEvents: Array<{ sessionId: string; event: RoutedAgentEvent }> = [];
  private flushHandle: number | null = null;

  constructor(private readonly options: ProviderEventControllerOptions) {}

  private now() {
    return this.options.services.now?.() ?? Date.now();
  }

  bindSession(provider: AgentProvider, nativeSessionId: string, sessionId: string) {
    if (nativeSessionId) this.threadSessions.set(nativeSessionKey(provider, nativeSessionId), sessionId);
  }

  sessionFor(provider: AgentProvider, nativeSessionId: string) {
    return this.mappedSession(provider, nativeSessionId);
  }

  takePendingStart(provider: AgentProvider, nativeSessionId: string) {
    const key = nativeSessionKey(provider, nativeSessionId);
    const event = this.pendingThreadStarts.get(key)?.event;
    this.pendingThreadStarts.delete(key);
    return event;
  }

  captureVersion(sessionId: string): ProviderEventVersion {
    const current = this.versions.get(sessionId);
    return current ? { ...current } : { event: 0, lifecycle: 0 };
  }

  changedSince(sessionId: string, snapshot: ProviderEventVersion) {
    const current = this.captureVersion(sessionId);
    return { preserveRealtime: current.event > snapshot.event, preserveLifecycle: current.lifecycle > snapshot.lifecycle };
  }

  release(sessionId: string) {
    for (const [key, mappedSessionId] of this.threadSessions) {
      if (mappedSessionId === sessionId) this.threadSessions.delete(key);
    }
    for (const [key, parentSessionId] of this.subagentParents) {
      if (parentSessionId === sessionId) this.subagentParents.delete(key);
    }
    this.pendingEvents = this.pendingEvents.filter((entry) => entry.sessionId !== sessionId);
    this.versions.delete(sessionId);
  }

  disconnectProvider(provider: AgentProvider) {
    const prefix = `${provider}:`;
    for (const key of this.pendingThreadStarts.keys()) if (key.startsWith(prefix)) this.pendingThreadStarts.delete(key);
    for (const key of this.subagentParents.keys()) if (key.startsWith(prefix)) this.subagentParents.delete(key);
    const providerSessionIds = new Set(Object.values(this.options.state.getSessions()).filter((session) => session.provider === provider).map((session) => session.id));
    for (const sessionId of providerSessionIds) this.release(sessionId);
  }

  private enqueue(sessionId: string, event: RoutedAgentEvent) {
    const current = this.captureVersion(sessionId);
    this.versions.set(sessionId, {
      event: current.event + 1,
      lifecycle: current.lifecycle + (event.lifecycle ? 1 : 0),
    });
    this.pendingEvents.push({ sessionId, event });
    if (event.batched) {
      if (this.flushHandle === null) this.flushHandle = this.options.services.requestFrame(this.flush);
      return;
    }
    this.flush();
  }

  readonly flush = () => {
    if (this.flushHandle !== null) {
      this.options.services.cancelFrame(this.flushHandle);
      this.flushHandle = null;
    }
    const batch = this.pendingEvents;
    if (!batch.length) return;
    this.pendingEvents = [];
    this.options.state.updateSessions((current) => {
      let next = current;
      for (const { sessionId, event } of batch) {
        const target = next[sessionId];
        if (!target) continue;
        const applied = applyAgentEvent(target, event);
        if (next === current) next = { ...current };
        const approvals = applied.approval && !applied.session.pendingApprovals.some((approval) =>
          (approval.interactionId || String(approval.requestId)) === (applied.approval?.interactionId || String(applied.approval?.requestId)))
          ? [...applied.session.pendingApprovals, applied.approval]
          : applied.session.pendingApprovals;
        next[sessionId] = approvals === applied.session.pendingApprovals
          ? applied.session
          : { ...applied.session, pendingApprovals: approvals };
      }
      return next;
    });
  };

  private mappedSession(provider: AgentProvider, nativeSessionId: string) {
    const mapped = this.threadSessions.get(nativeSessionKey(provider, nativeSessionId));
    const sessions = this.options.state.getSessions();
    if (mapped && sessions[mapped]?.provider === provider) return mapped;
    return Object.values(sessions).find((session) => session.provider === provider && session.threadId === nativeSessionId)?.id;
  }

  private isStale(session: SessionState, event: RoutedAgentEvent) {
    const generation = event.envelope.queryGeneration;
    return Number.isSafeInteger(generation) && Number(generation) < session.queryGeneration;
  }

  readonly handleEnvelope = (envelope: AgentEventEnvelope) => {
    const event = routeAgentEvent(envelope);
    const payload = agentEventPayload(event);
    const { state, runtime, services } = this.options;
    if (event.kind === "ready") { services.setReady(); return; }
    if (event.kind === "sessionDeleted") {
      const nativeSessionId = event.nativeSessionId || "";
      if (!nativeSessionId) return;
      services.removeHistory(event.provider, nativeSessionId);
      const sessionId = this.mappedSession(event.provider, nativeSessionId);
      const session = sessionId ? state.getSessions()[sessionId] : undefined;
      if (session) {
        services.appendRawEvent(session.id, envelope.type, envelope);
        if (session.status !== "working") services.clearSession(session.id);
      }
      return;
    }
    if (event.kind === "backendExited") {
      this.disconnectProvider(event.provider);
      services.recoverProvider(event.provider);
      return;
    }
    if (event.kind === "closeActiveTab") { services.closeActiveTab(); return; }
    if (event.kind === "skillsChanged") { services.reloadSkills(); return; }
    if (event.kind === "activateSession") {
      const sessionId = notificationActivationTarget(state.getSessions(), event.clientSessionId || "");
      if (sessionId) services.activateSession(sessionId);
      return;
    }
    if (event.kind === "lateResponse") {
      const sessionId = event.clientSessionId || "";
      const requestMethod = event.lateResponse?.operation;
      const response = { result: event.lateResponse?.result, error: event.lateResponse?.error };
      if (!sessionId || !state.getSessions()[sessionId]) return;
      services.appendRawEvent(sessionId, `late response ${requestMethod}`, response);
      if (requestMethod === "startSession") {
        if (response.error) runtime.lifecycle.rejectStart(sessionId, new Error(stringValue(asRecord(response.error).message, "创建会话失败")));
        else runtime.lifecycle.resolveLateStart(sessionId, response.result, (value) => services.adoptStartedThread(sessionId, value));
      } else if (requestMethod === "startTurn") {
        const turnId = stringValue(asRecord(asRecord(response.result).turn).id);
        if (turnId) state.updateSession(sessionId, (current) => current.status === "working" && !current.activeTurnId ? { ...current, activeTurnId: turnId } : current);
      }
      return;
    }
    if (event.kind === "openWorkspace") {
      if (event.workspace) services.openWorkspace(event.workspace);
      return;
    }
    if (event.kind === "sessionStarted") {
      const nativeSessionId = event.nativeSessionId || "";
      if (!nativeSessionId) return;
      const threadKey = nativeSessionKey(event.provider, nativeSessionId);
      const parentThreadId = event.parentNativeSessionId || "";
      if (parentThreadId) {
        const parentSessionId = this.mappedSession(event.provider, parentThreadId);
        if (parentSessionId) {
          this.subagentParents.set(threadKey, parentSessionId);
          services.appendRawEvent(parentSessionId, `subagent ${envelope.type}`, envelope);
          state.updateSession(parentSessionId, (current) => applyAgentSubagentEvent(current, event, nativeSessionId));
        }
        return;
      }
      const cutoff = this.now() - 10 * 60_000;
      for (const [key, pending] of this.pendingThreadStarts) if (pending.receivedAt < cutoff) this.pendingThreadStarts.delete(key);
      const sessionId = this.threadSessions.get(threadKey);
      if (sessionId && state.getSessions()[sessionId]?.provider === event.provider) {
        services.appendRawEvent(sessionId, envelope.type, envelope);
        this.enqueue(sessionId, event);
      } else {
        this.pendingThreadStarts.set(threadKey, { event, receivedAt: this.now() });
      }
      return;
    }

    const nativeSessionId = event.nativeSessionId;
    if (!nativeSessionId) return;
    const threadKey = nativeSessionKey(event.provider, nativeSessionId);
    const directSession = event.clientSessionId ? state.getSessions()[event.clientSessionId] : undefined;
    const directSessionId = directSession?.provider === event.provider ? directSession.id : undefined;
    if (directSessionId) this.threadSessions.set(threadKey, directSessionId);
    const ownerSessionId = directSessionId || this.threadSessions.get(threadKey);
    if (event.childNativeSessionId && ownerSessionId) this.subagentParents.set(nativeSessionKey(event.provider, event.childNativeSessionId), ownerSessionId);
    const parentSessionId = this.subagentParents.get(threadKey);
    if (parentSessionId && state.getSessions()[parentSessionId]?.provider === event.provider) {
      services.appendRawEvent(parentSessionId, `subagent ${envelope.type}`, envelope);
      state.updateSession(parentSessionId, (current) => applyAgentSubagentEvent(current, event, nativeSessionId));
      return;
    }
    const sessionId = directSessionId || this.mappedSession(event.provider, nativeSessionId);
    if (!sessionId) return;
    const session = state.getSessions()[sessionId];
    if (!session || this.isStale(session, event)) return;

    if (envelope.type === "claude/capabilitiesUpdated") {
      const runtimeModels = Array.isArray(payload.models)
        ? payload.models.map((model) => normalizeAgentModel(event.provider, model)).filter((model) => model.id)
        : [];
      if (runtimeModels.length) services.updateProviderModels(event.provider, runtimeModels);
      services.loadSkills(sessionId, session.cwd || state.getWorkspace(), true);
    }
    if (event.kind === "sessionSettingsUpdated") {
      const settings = event.settings || {};
      const fallback = { model: session.model || "", effort: session.effort || "" };
      const current = runtime.settings.confirmed(sessionId, fallback);
      const hadPendingRequest = runtime.settings.hasPending(sessionId);
      runtime.settings.setConfirmed(sessionId, {
        model: settings.model || current.model,
        effort: settings.effort || current.effort,
      });
      if (hadPendingRequest) {
        const version = this.captureVersion(sessionId);
        this.versions.set(sessionId, { ...version, event: version.event + 1 });
        services.appendRawEvent(sessionId, envelope.type, envelope);
        return;
      }
    }
    if (event.committedClientId) runtime.messages.commitPendingSteer(sessionId, event.committedClientId);
    if (event.kind === "turnCompleted") {
      const turnStatus = event.turnStatus || "completed";
      runtime.messages.handleTurnCompleted(sessionId, turnStatus);
      if (turnStatus !== "interrupted" && (!services.isDocumentFocused() || state.getActiveSessionId() !== sessionId)) {
        services.showNotification(session);
      }
    }
    services.rememberModelContextWindow(sessionId, event);
    services.appendRawEvent(sessionId, envelope.type, envelope);
    this.enqueue(sessionId, event);
  };
}
