import type { AgentBackend } from "./AgentBackend";
import type { AgentEventEnvelope, AgentOperation, AgentProvider, AgentRequestContext, InteractionRef } from "../../shared/agentProtocol";
import type { JsonObject } from "../../shared/protocol";

export class BackendManager {
  private readonly backends = new Map<AgentProvider, AgentBackend>();
  private readonly listeners = new Set<(event: AgentEventEnvelope) => void>();
  private readonly subscriptions = new Map<AgentProvider, () => void>();
  private closePromise: Promise<void> | null = null;

  register(backend: AgentBackend) {
    if (this.backends.has(backend.provider)) throw new Error(`Provider 已注册：${backend.provider}`);
    this.backends.set(backend.provider, backend);
    this.subscriptions.set(backend.provider, backend.subscribeEvents((event) => {
      if (event.provider !== backend.provider) return;
      this.listeners.forEach((listener) => listener(event));
    }));
  }

  has(provider: AgentProvider) {
    return this.backends.has(provider);
  }

  async request(provider: AgentProvider, operation: AgentOperation, params: JsonObject = {}, context: AgentRequestContext = {}) {
    const backend = this.require(provider);
    if (operation === "getCapabilities") return backend.getCapabilities();
    if (operation === "closeSession") return backend.closeSession(context);
    return backend.request(operation, params, context);
  }

  respond(ref: InteractionRef, result: JsonObject) {
    return this.require(ref.provider).respondToInteraction(ref, result);
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
    })().catch((error) => {
      this.closePromise = null;
      throw error;
    });
    return this.closePromise;
  }

  private require(provider: AgentProvider) {
    const backend = this.backends.get(provider);
    if (!backend) throw new Error(`Provider 暂不可用：${provider}`);
    return backend;
  }
}
