import { ThreadStartCoordinator } from "./threadStartCoordinator";

export interface EnsureThreadOptions {
  threadId: string | null;
  resumed: boolean;
  claimExisting?: () => void;
  resume?: () => Promise<unknown>;
  start: () => Promise<unknown>;
  adopt: (value: unknown) => string;
  isStartTimeout: (error: unknown) => boolean;
  onStartTimeout: () => void;
  onStartLateTimeout?: () => void | Promise<void>;
}

export class SessionLifecycleController {
  private readonly starts = new ThreadStartCoordinator();
  private readonly resumes = new Map<string, Promise<unknown>>();
  private readonly closes = new Map<string, Promise<void>>();

  resume<T>(sessionId: string, create: () => Promise<T>): Promise<T> {
    const existing = this.resumes.get(sessionId) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = Promise.resolve().then(create);
    this.resumes.set(sessionId, promise);
    void promise.catch(() => undefined).finally(() => {
      if (this.resumes.get(sessionId) === promise) this.resumes.delete(sessionId);
    });
    return promise;
  }

  async ensureThread(sessionId: string, options: EnsureThreadOptions) {
    if (options.threadId) {
      options.claimExisting?.();
      const guard = this.resumes.get(sessionId);
      if (guard) await guard;
      else if (!options.resumed) {
        if (!options.resume) throw new Error("历史会话缺少恢复操作。");
        await this.resume(sessionId, options.resume);
      }
      return options.threadId;
    }
    return this.starts.start(
      sessionId,
      options.start,
      options.adopt,
      options.isStartTimeout,
      options.onStartTimeout,
      options.onStartLateTimeout,
    );
  }

  close(sessionId: string, create: () => Promise<void>) {
    const existing = this.closes.get(sessionId);
    if (existing) return existing;
    const promise = Promise.resolve().then(create).finally(() => {
      if (this.closes.get(sessionId) === promise) this.closes.delete(sessionId);
    });
    this.closes.set(sessionId, promise);
    return promise;
  }

  resolveLateStart(sessionId: string, value: unknown, adopt: (value: unknown) => string) {
    return this.starts.resolveLate(sessionId, value, adopt);
  }

  rejectStart(sessionId: string, error: Error) {
    this.starts.reject(sessionId, error);
  }

  release(sessionId: string, reason = "会话已关闭。") {
    this.resumes.delete(sessionId);
    this.starts.reject(sessionId, new Error(reason));
  }

  disconnect(sessionIds: Iterable<string>, error: Error) {
    for (const sessionId of sessionIds) {
      this.resumes.delete(sessionId);
      this.starts.reject(sessionId, error);
    }
  }
}
