import { BackendManager } from "./BackendManager";
import type { AgentBackend } from "./AgentBackend";
import type { AppLogger } from "../logger";
import type { NativeSessionOwnershipRegistry } from "./nativeSessionOwnershipRegistry";

export function createBackendRegistry(backends: AgentBackend[], logger?: AppLogger, isWorkspaceAuthorized?: (cwd: string) => boolean, nativeOwnership?: NativeSessionOwnershipRegistry) {
  const manager = new BackendManager(logger, isWorkspaceAuthorized, nativeOwnership);
  backends.forEach((backend) => manager.register(backend));
  return manager;
}
