import { BackendManager } from "./BackendManager";
import type { AgentBackend } from "./AgentBackend";

export function createBackendRegistry(backends: AgentBackend[]) {
  const manager = new BackendManager();
  backends.forEach((backend) => manager.register(backend));
  return manager;
}
