import { BackendManager } from "./BackendManager";
import type { AgentBackend } from "./AgentBackend";
import type { AppLogger } from "../logger";

export function createBackendRegistry(backends: AgentBackend[], logger?: AppLogger, isWorkspaceAuthorized?: (cwd: string) => boolean) {
  const manager = new BackendManager(logger, isWorkspaceAuthorized);
  backends.forEach((backend) => manager.register(backend));
  return manager;
}
