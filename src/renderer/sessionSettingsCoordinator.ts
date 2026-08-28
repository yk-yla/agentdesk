import type { CollaborationMode } from "./domain";

export interface SessionSettings {
  model: string;
  effort: string;
  collaborationMode: CollaborationMode;
}

interface SettingsEntry {
  version: number;
  confirmed: SessionSettings;
  desired: SessionSettings;
  chain: Promise<void> | null;
}

export interface SettingsRequest {
  promise: Promise<void>;
  isLatest: () => boolean;
}

export class SessionSettingsCoordinator {
  private entries = new Map<string, SettingsEntry>();

  initialize(sessionId: string, settings: SessionSettings) {
    if (this.entries.has(sessionId)) return;
    this.entries.set(sessionId, { version: 0, confirmed: settings, desired: settings, chain: null });
  }

  setConfirmed(sessionId: string, settings: SessionSettings) {
    const current = this.entries.get(sessionId);
    if (!current) {
      this.initialize(sessionId, settings);
      return;
    }
    current.confirmed = settings;
    if (!current.chain) current.desired = settings;
  }

  desired(sessionId: string, fallback: SessionSettings) {
    return this.entries.get(sessionId)?.desired || fallback;
  }

  confirmed(sessionId: string, fallback: SessionSettings) {
    return this.entries.get(sessionId)?.confirmed || fallback;
  }

  hasPending(sessionId: string) {
    return Boolean(this.entries.get(sessionId)?.chain);
  }

  enqueue(sessionId: string, target: SessionSettings, send: (settings: SessionSettings) => Promise<void>): SettingsRequest {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { version: 0, confirmed: target, desired: target, chain: null };
      this.entries.set(sessionId, entry);
    }
    entry.version += 1;
    const version = entry.version;
    entry.desired = target;
    const previous = entry.chain || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await send(target);
      const latestEntry = this.entries.get(sessionId);
      if (latestEntry) latestEntry.confirmed = target;
    });
    const promise = operation.catch((error: unknown) => {
      const latestEntry = this.entries.get(sessionId);
      if (latestEntry?.version === version) latestEntry.desired = latestEntry.confirmed;
      throw error;
    });
    entry.chain = promise;
    void promise.finally(() => {
      const latestEntry = this.entries.get(sessionId);
      if (latestEntry?.chain === promise) latestEntry.chain = null;
    }).catch(() => undefined);
    return { promise, isLatest: () => this.entries.get(sessionId)?.version === version };
  }

  delete(sessionId: string) {
    this.entries.delete(sessionId);
  }

  clear() {
    this.entries.clear();
  }
}
