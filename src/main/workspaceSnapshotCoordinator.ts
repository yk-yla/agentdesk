import type { JsonObject } from "../shared/protocol";

interface PendingSnapshot {
  resolve(result: WorkspaceSnapshotResult): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export type WorkspaceSnapshotResult = "saved" | "renderer-unavailable" | "timeout";

export interface WorkspaceSnapshotCoordinatorDependencies {
  createRequestId(): string;
  requestFromRenderer(requestId: string): boolean;
  save(workspaceState: JsonObject): Promise<unknown>;
}

export class WorkspaceSnapshotCoordinator {
  private readonly pending = new Map<string, PendingSnapshot>();

  constructor(private readonly dependencies: WorkspaceSnapshotCoordinatorDependencies) {}

  request(timeoutMs = 3_000): Promise<WorkspaceSnapshotResult> {
    const requestId = this.dependencies.createRequestId();
    return new Promise<WorkspaceSnapshotResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve("timeout");
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      if (this.dependencies.requestFromRenderer(requestId)) return;
      clearTimeout(timer);
      this.pending.delete(requestId);
      resolve("renderer-unavailable");
    });
  }

  async complete(requestId: string, workspaceState: JsonObject) {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error("工作区快照请求不存在或已过期。");
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    try {
      await this.dependencies.save(workspaceState);
      pending.resolve("saved");
    } catch (error) {
      pending.reject(error);
      throw error;
    }
  }
}
