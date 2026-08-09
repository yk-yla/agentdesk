export interface PendingRpcRequest<TChild> {
  child: TChild;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  method: string;
  sessionId?: string;
}

interface TrackedPendingRpcRequest<TChild> extends PendingRpcRequest<TChild> {
  timeout: ReturnType<typeof setTimeout>;
}

export interface TimedOutRpcRequest<TChild> {
  child: TChild;
  method: string;
  sessionId?: string;
}

export type TrackedRpcResponse<TChild> =
  | { kind: "pending"; request: PendingRpcRequest<TChild> }
  | { kind: "late"; request: TimedOutRpcRequest<TChild> };

export class RpcRequestRegistry<TChild> {
  private readonly pending = new Map<number, TrackedPendingRpcRequest<TChild>>();
  private readonly timedOut = new Map<number, TimedOutRpcRequest<TChild>>();

  constructor(private readonly maxTimedOutRequests: number) {}

  add(id: number, request: PendingRpcRequest<TChild>, timeoutMs: number, timeoutError: () => Error) {
    const timeout = setTimeout(() => {
      const current = this.pending.get(id);
      if (!current || current.child !== request.child) return;
      this.pending.delete(id);
      this.timedOut.set(id, { child: current.child, method: current.method, sessionId: current.sessionId });
      while (this.timedOut.size > this.maxTimedOutRequests) {
        const oldest = this.timedOut.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        this.timedOut.delete(oldest);
      }
      current.reject(timeoutError());
    }, timeoutMs);
    this.pending.set(id, { ...request, timeout });
  }

  cancel(id: number, child: TChild) {
    const request = this.pending.get(id);
    if (!request || request.child !== child) return false;
    clearTimeout(request.timeout);
    this.pending.delete(id);
    return true;
  }

  takeResponse(id: number, child: TChild): TrackedRpcResponse<TChild> | null {
    const waiting = this.pending.get(id);
    if (waiting?.child === child) {
      clearTimeout(waiting.timeout);
      this.pending.delete(id);
      return { kind: "pending", request: waiting };
    }
    const timedOut = this.timedOut.get(id);
    if (timedOut?.child !== child) return null;
    this.timedOut.delete(id);
    return { kind: "late", request: timedOut };
  }

  reject(reason: Error, child?: TChild) {
    for (const [id, waiting] of this.pending) {
      if (child !== undefined && waiting.child !== child) continue;
      clearTimeout(waiting.timeout);
      waiting.reject(reason);
      this.pending.delete(id);
    }
    for (const [id, timedOut] of this.timedOut) {
      if (child === undefined || timedOut.child === child) this.timedOut.delete(id);
    }
  }

  get pendingCount() {
    return this.pending.size;
  }

  get timedOutCount() {
    return this.timedOut.size;
  }
}
