import type { AgentProvider } from "../shared/agentProtocol";
import { providerNotificationTitle } from "../shared/providerMetadata";

export interface NormalizedDesktopNotification {
  sessionId: string;
  provider: AgentProvider;
  title: string;
  body?: string;
}

export const DESKTOP_NOTIFICATION_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const MAX_RETAINED_DESKTOP_NOTIFICATIONS = 128;

/**
 * Electron requires a live Notification object for interaction events. Keep a
 * bounded strong reference so Windows Action Center clicks still reach the app.
 */
export class DesktopNotificationRetention<T extends object> {
  private readonly entries = new Map<T, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly maxEntries = MAX_RETAINED_DESKTOP_NOTIFICATIONS,
    private readonly retentionMs = DESKTOP_NOTIFICATION_RETENTION_MS,
  ) {}

  retain(notification: T) {
    this.release(notification);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as T | undefined;
      if (!oldest) break;
      this.release(oldest);
    }
    const timer = setTimeout(() => this.release(notification), this.retentionMs);
    if (typeof timer === "object") timer.unref();
    this.entries.set(notification, timer);
  }

  release(notification: T) {
    const timer = this.entries.get(notification);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.entries.delete(notification);
  }

  get size() {
    return this.entries.size;
  }
}

export function normalizeDesktopNotification(input: unknown): NormalizedDesktopNotification | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim().slice(0, 160) : "";
  const provider = value.provider === "codex" || value.provider === "claude" ? value.provider : null;
  if (!sessionId || !provider) return null;
  const body = typeof value.sessionTitle === "string" ? value.sessionTitle.trim().slice(0, 120) : "";
  return { sessionId, provider, title: providerNotificationTitle(provider), ...(body ? { body } : {}) };
}

