export type WorkspaceAuthorizationSource = "explicit" | "provider";

interface WorkspaceAuthorizationEntry {
  source: WorkspaceAuthorizationSource;
}

export class WorkspaceAuthorizationRegistry {
  private readonly entries = new Map<string, WorkspaceAuthorizationEntry>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("工作区授权容量无效。");
  }

  register(canonicalPath: string, source: WorkspaceAuthorizationSource) {
    const existing = this.entries.get(canonicalPath);
    const nextSource = existing?.source === "explicit" ? "explicit" : source;
    this.entries.delete(canonicalPath);
    this.entries.set(canonicalPath, { source: nextSource });
    this.trim();
  }

  has(canonicalPath: string) {
    return this.entries.has(canonicalPath);
  }

  paths() {
    return [...this.entries.keys()];
  }

  clear() {
    this.entries.clear();
  }

  private trim() {
    while (this.entries.size > this.capacity) {
      const providerPath = [...this.entries].find(([, entry]) => entry.source === "provider")?.[0];
      const oldestPath = this.entries.keys().next().value as string | undefined;
      const evictedPath = providerPath || oldestPath;
      if (!evictedPath) return;
      this.entries.delete(evictedPath);
    }
  }
}
