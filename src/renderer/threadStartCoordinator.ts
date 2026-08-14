interface Attempt {
  promise: Promise<string>;
  resolve: (threadId: string) => void;
  reject: (error: Error) => void;
  lateResponseTimer: ReturnType<typeof setTimeout> | null;
}

export class ThreadStartCoordinator {
  private readonly attempts = new Map<string, Attempt>();

  constructor(private readonly lateResponseTimeoutMs = 2 * 60_000) {}

  start(
    sessionId: string,
    request: () => Promise<unknown>,
    adopt: (value: unknown) => string,
    isTimeout: (error: unknown) => boolean,
    onTimeout: () => void,
    onLateResponseTimeout?: () => void | Promise<void>,
  ) {
    const existing = this.attempts.get(sessionId);
    if (existing) return existing.promise;

    let resolveAttempt!: (threadId: string) => void;
    let rejectAttempt!: (error: Error) => void;
    const promise = new Promise<string>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    const attempt: Attempt = { promise, resolve: resolveAttempt, reject: rejectAttempt, lateResponseTimer: null };
    this.attempts.set(sessionId, attempt);

    void Promise.resolve().then(request).then((value) => {
      if (this.attempts.get(sessionId) !== attempt) return;
      try {
        const threadId = adopt(value);
        this.attempts.delete(sessionId);
        resolveAttempt(threadId);
      } catch (error) {
        this.reject(sessionId, error instanceof Error ? error : new Error("创建会话失败"));
      }
    }).catch((error) => {
      if (this.attempts.get(sessionId) !== attempt) return;
      if (isTimeout(error)) {
        try {
          onTimeout();
        } catch (timeoutError) {
          this.reject(sessionId, timeoutError instanceof Error ? timeoutError : new Error("创建会话失败"));
          return;
        }
        attempt.lateResponseTimer = setTimeout(() => {
          if (this.attempts.get(sessionId) !== attempt) return;
          void Promise.resolve().then(onLateResponseTimeout).catch(() => undefined).finally(() => {
            if (this.attempts.get(sessionId) === attempt) this.reject(sessionId, new Error("创建会话后台确认超时，请重新发送。"));
          });
        }, this.lateResponseTimeoutMs);
        return;
      }
      this.reject(sessionId, error instanceof Error ? error : new Error("创建会话失败"));
    });
    return promise;
  }

  resolveLate(sessionId: string, value: unknown, adopt: (value: unknown) => string) {
    const attempt = this.attempts.get(sessionId);
    if (!attempt) return false;
    try {
      const threadId = adopt(value);
      this.attempts.delete(sessionId);
      if (attempt.lateResponseTimer) clearTimeout(attempt.lateResponseTimer);
      attempt.resolve(threadId);
    } catch (error) {
      this.reject(sessionId, error instanceof Error ? error : new Error("创建会话失败"));
    }
    return true;
  }

  reject(sessionId: string, error: Error) {
    const attempt = this.attempts.get(sessionId);
    if (!attempt) return false;
    this.attempts.delete(sessionId);
    if (attempt.lateResponseTimer) clearTimeout(attempt.lateResponseTimer);
    attempt.reject(error);
    return true;
  }

  rejectAll(error: Error) {
    for (const sessionId of [...this.attempts.keys()]) this.reject(sessionId, error);
  }
}
