import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ClaudeWorkerCommand, ClaudeWorkerEvent } from "./claudeWorkerProtocol";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const FATAL_CLEANUP_TIMEOUT_MS = 10_000;

function validEvent(value: unknown): value is ClaudeWorkerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.type === "string" && ["message", "ready", "processStarted", "interrupted", "closed", "interactionPending", "interactionFinished", "response", "error", "fatal"].includes(event.type);
}

export class ClaudeWorkerHost {
  private worker: Worker | null = null;
  private closing = false;
  private readonly listeners = new Set<(event: ClaudeWorkerEvent) => void>();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly workerPath: () => string) {}

  subscribe(listener: (event: ClaudeWorkerEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(command: ClaudeWorkerCommand) {
    const serialized = JSON.stringify(command);
    if (Buffer.byteLength(serialized, "utf8") > MAX_MESSAGE_BYTES) throw new Error("Claude Worker 请求过大。");
    this.ensureWorker().postMessage(command);
  }

  closeSession(sessionId: string, queryGeneration?: number) {
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Claude Worker 关闭会话超时。"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve: () => resolve(), reject, timer });
      try {
        const payload = { type: "closeSession", sessionId, queryGeneration, requestId } as ClaudeWorkerCommand;
        const serialized = JSON.stringify(payload);
        if (Buffer.byteLength(serialized, "utf8") > MAX_MESSAGE_BYTES) throw new Error("Claude Worker 请求过大。");
        this.ensureWorker().postMessage(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error("Claude Worker 请求失败。"));
      }
    });
  }

  request(command: Exclude<ClaudeWorkerCommand, { type: "start" | "send" | "interrupt" | "closeSession" | "testHoldRequests" | "testFatal" | "close" }>) {
    const requestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Claude Worker 请求超时。"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        const payload = { ...command, requestId } as ClaudeWorkerCommand;
        const serialized = JSON.stringify(payload);
        if (Buffer.byteLength(serialized, "utf8") > MAX_MESSAGE_BYTES) throw new Error("Claude Worker 请求过大。");
        this.ensureWorker().postMessage(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error("Claude Worker 请求失败。"));
      }
    });
  }

  injectFatalForTesting(message = "Claude Worker 验收故障注入。") {
    const worker = this.worker;
    if (!worker) throw new Error("Claude Worker 尚未启动。");
    worker.postMessage({ type: "testFatal", message } satisfies ClaudeWorkerCommand);
  }

  holdRequestsForTesting() {
    const worker = this.worker;
    if (!worker) throw new Error("Claude Worker 尚未启动。");
    worker.postMessage({ type: "testHoldRequests" } satisfies ClaudeWorkerCommand);
  }

  async close() {
    const worker = this.worker;
    if (!worker) return;
    this.closing = true;
    worker.postMessage({ type: "close" } satisfies ClaudeWorkerCommand);
    await Promise.race([
      new Promise<void>((resolve) => worker.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (this.worker === worker) await worker.terminate();
    this.worker = null;
    this.rejectPending(new Error("Claude Worker 已关闭。"));
    this.closing = false;
  }

  private ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(pathToFileURL(this.workerPath()));
    worker.on("message", (value: unknown) => {
      let size = MAX_MESSAGE_BYTES + 1;
      try { size = Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { /* invalid */ }
      if (size > MAX_MESSAGE_BYTES || !validEvent(value)) {
        void this.failWorker(worker, new Error("Claude Worker 返回了无效消息。"));
        return;
      }
      if (value.type === "response") {
        const pending = this.pending.get(value.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(value.requestId);
          if (value.error) pending.reject(new Error(value.error));
          else pending.resolve(value.result);
        }
        return;
      }
      if (value.type === "fatal") {
        void this.failWorker(worker, new Error(value.message), false);
        return;
      }
      this.emit(value);
    });
    worker.on("error", (error) => { void this.failWorker(worker, error); });
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      if (this.closing) this.worker = null;
      else void this.failWorker(worker, new Error(`Claude Worker 异常退出（${code}）。`), false);
    });
    this.worker = worker;
    return worker;
  }

  private emit(event: ClaudeWorkerEvent) {
    this.listeners.forEach((listener) => listener(event));
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async failWorker(worker: Worker, error: Error, terminate = true) {
    if (this.worker !== worker) return;
    this.worker = null;
    this.rejectPending(error);
    this.emit({ type: "fatal", message: error.message });
    if (terminate) {
      await worker.terminate().catch(() => undefined);
      return;
    }
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => worker.once("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), FATAL_CLEANUP_TIMEOUT_MS)),
    ]);
    if (!exited) await worker.terminate().catch(() => undefined);
  }
}
