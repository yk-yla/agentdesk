import { BackendManager } from "./BackendManager";
import type { AgentBackend } from "./AgentBackend";
import type { AppLogger } from "../logger";

export function createBackendRegistry(backends: AgentBackend[], logger?: AppLogger) {
  const manager = new BackendManager(logger);
  backends.forEach((backend) => manager.register(backend));
  return manager;
}
