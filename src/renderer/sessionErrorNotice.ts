import type { SessionErrorNotice, SessionNoticeLifetime, SessionState } from "./domain";

export const TRANSIENT_NOTICE_DURATION_MS = 8_000;
export const LIGHTWEIGHT_NOTICE_DURATION_MS = 10_000;
export const SUCCESS_NOTICE_DURATION_MS = 4_000;

export interface SessionErrorNoticeOptions {
  lifetime?: SessionNoticeLifetime;
  durationMs?: number;
  now?: number;
}

export function sessionErrorNoticePatch(message: string, options: SessionErrorNoticeOptions = {}): Pick<SessionState, "errorText" | "errorNotice"> {
  if (!message) return { errorText: "", errorNotice: undefined };
  const lifetime = options.lifetime || "manual";
  return {
    errorText: message,
    errorNotice: {
      message,
      lifetime,
      ...(lifetime === "transient" ? { durationMs: options.durationMs || TRANSIENT_NOTICE_DURATION_MS } : {}),
      createdAt: options.now ?? Date.now(),
    },
  };
}

export function normalizeSessionErrorNotice(current: SessionState, next: SessionState, now = Date.now()): SessionState {
  if (!next.errorText) {
    return next.errorNotice === undefined ? next : { ...next, errorNotice: undefined };
  }
  if (next.errorNotice?.message === next.errorText) return next;
  if (current.errorText === next.errorText && current.errorNotice?.message === next.errorText) {
    return { ...next, errorNotice: current.errorNotice };
  }
  return { ...next, ...sessionErrorNoticePatch(next.errorText, { now }) };
}

export function currentSessionErrorNotice(session: Pick<SessionState, "errorText" | "errorNotice">): SessionErrorNotice | null {
  return session.errorText && session.errorNotice?.message === session.errorText ? session.errorNotice : null;
}

export function sessionErrorNoticeIdentity(session: Pick<SessionState, "errorText" | "errorNotice">) {
  const notice = currentSessionErrorNotice(session);
  return notice ? `${notice.createdAt}:${notice.message}` : null;
}

export function sessionErrorAutoDismissMs(session: Pick<SessionState, "errorText" | "errorNotice">) {
  const notice = currentSessionErrorNotice(session);
  return notice?.lifetime === "transient" ? notice.durationMs || TRANSIENT_NOTICE_DURATION_MS : null;
}
