import type { SessionState } from "./domain";

export function notificationActivationTarget(sessions: Record<string, SessionState>, sessionId: string) {
  return sessionId && sessions[sessionId] ? sessionId : null;
}

