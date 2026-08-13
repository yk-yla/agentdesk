export interface CloseSessionResourcesOptions {
  shouldInterrupt: boolean;
  shouldClose: boolean;
  interrupt: () => Promise<void>;
  waitForIdle: () => Promise<void>;
  close: () => Promise<void>;
}

export interface CloseSessionResourcesResult {
  interruptError?: unknown;
  closeError?: unknown;
}

export function reuseSessionClose<T>(active: Map<string, Promise<T>>, sessionId: string, create: () => Promise<T>) {
  const existing = active.get(sessionId);
  if (existing) return existing;
  let operation!: Promise<T>;
  operation = create().finally(() => {
    if (active.get(sessionId) === operation) active.delete(sessionId);
  });
  active.set(sessionId, operation);
  return operation;
}

/**
 * 停止回合和释放会话是两个独立动作。即使前一步失败或超时，也必须
 * 尝试关闭后端资源，避免 Query/Worker 因一个迟到的状态事件继续存活。
 */
export async function closeSessionResources(options: CloseSessionResourcesOptions): Promise<CloseSessionResourcesResult> {
  let interruptError: unknown;
  if (options.shouldInterrupt) {
    try {
      await options.interrupt();
      await options.waitForIdle();
    } catch (error) {
      interruptError = error;
    }
  }

  let closeError: unknown;
  if (options.shouldClose) {
    try {
      await options.close();
    } catch (error) {
      closeError = error;
    }
  }
  return { ...(interruptError === undefined ? {} : { interruptError }), ...(closeError === undefined ? {} : { closeError }) };
}
