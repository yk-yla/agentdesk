export const MAX_WORKSPACE_RESTORE_ATTEMPTS = 3;

export function workspaceRestoreRetry(attempt: number) {
  const nextAttempt = Math.max(1, Math.floor(attempt) + 1);
  if (nextAttempt >= MAX_WORKSPACE_RESTORE_ATTEMPTS) return { attempt: nextAttempt, delayMs: null };
  return { attempt: nextAttempt, delayMs: nextAttempt * 750 };
}

export function finishWorkspaceRestore(pending: Set<string>, inFlight: Set<string>, sessionId: string) {
  pending.delete(sessionId);
  inFlight.delete(sessionId);
}
