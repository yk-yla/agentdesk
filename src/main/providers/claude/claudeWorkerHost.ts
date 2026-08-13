import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ClaudeWorkerCommand, ClaudeWorkerEvent } from "./claudeWorkerProtocol";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const COMPACT_REQUEST_TIMEOUT_MS = 180_000;
const PLUGIN_REQUEST_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 25_000;

export interface ClaudeWorkerHostOptions {
  cleanupTimeoutMs?: number;
  exitTimeoutMs?: number;
  reportCleanupFailure?(message: string): void;
}

function validEvent(value: unknown): value is ClaudeWorkerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.type === "string" && ["message", "ready", "processStarted", "interrupted", "closed", "interactionPending", "interactionFinished", "cleanupComplete", "response", "error", "fatal"].includes(event.type);
}

export class ClaudeWorkerHost {
  private worker: Worker | null = null;
  private closing = false;
  private readonly listeners = new Set<(event: ClaudeWorkerEvent) => void>();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly workerPath: () => string,
    private readonly options: ClaudeWorkerHostOptions = {},
  ) {}

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
    const timeoutMs = command.type === "compactSession" ? COMPACT_REQUEST_TIMEOUT_MS : command.type === "plugin" ? PLUGIN_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(command.type === "compactSession" ? "Claude Worker 压缩请求超时。" : "Claude Worker 请求超时。"));
      }, timeoutMs);
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
    try {
      await this.completeCleanup(worker, true);
    } finally {
      if (this.worker === worker) this.worker = null;
      this.rejectPending(new Error("Claude Worker 已关闭。"));
      this.closing = false;
    }
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
      if (value.type === "cleanupComplete") return;
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
      else void this.failWorker(worker, new Error(`Claude Worker 异常退出（${code}）。`), false, true);
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

  private waitForCleanup(worker: Worker, requestClose: boolean) {
    return new Promise<{ kind: "complete"; error?: string } | { kind: "exit" } | { kind: "timeout" }>((resolve) => {
      let settled = false;
      const finish = (result: { kind: "complete"; error?: string } | { kind: "exit" } | { kind: "timeout" }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.removeListener("message", onMessage);
        worker.removeListener("exit", onExit);
        resolve(result);
      };
      const onMessage = (value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const event = value as Record<string, unknown>;
        if (event.type !== "cleanupComplete") return;
        finish({ kind: "complete", ...(typeof event.error === "string" && event.error ? { error: event.error } : {}) });
      };
      const onExit = () => finish({ kind: "exit" });
      const timer = setTimeout(() => finish({ kind: "timeout" }), this.options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS);
      worker.on("message", onMessage);
      worker.once("exit", onExit);
      if (requestClose) worker.postMessage({ type: "close" } satisfies ClaudeWorkerCommand);
    });
  }

  private waitForExit(worker: Worker, timeoutMs: number) {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.removeListener("exit", onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      worker.once("exit", onExit);
    });
  }

  private async terminateAfterCleanupFailure(worker: Worker, message: string) {
    try { this.options.reportCleanupFailure?.(message); } catch { /* cleanup must continue */ }
    await worker.terminate().catch(() => undefined);
  }

  private async completeCleanup(worker: Worker, requestClose: boolean) {
    const exitPromise = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    const result = await this.waitForCleanup(worker, requestClose);
    if (result.kind === "complete" && !result.error) {
      const exited = await Promise.race([
        exitPromise.then(() => true),
        this.waitForExit(worker, this.options.exitTimeoutMs ?? 1_000),
      ]);
      if (!exited) await this.terminateAfterCleanupFailure(worker, "Claude Worker 清理完成后未按时退出。");
      return;
    }
    const message = result.kind === "complete"
      ? `Claude Worker 清理失败：${result.error}`
      : result.kind === "exit"
        ? "Claude Worker 未确认清理完成。"
        : "Claude Worker 清理超时。";
    await this.terminateAfterCleanupFailure(worker, message);
  }

  private async failWorker(worker: Worker, error: Error, terminate = true, exited = false) {
    if (this.worker !== worker) return;
    this.worker = null;
    this.rejectPending(error);
    this.emit({ type: "fatal", message: error.message });
    if (exited) return;
    if (terminate) {
      await worker.terminate().catch(() => undefined);
      return;
    }
    await this.completeCleanup(worker, false);
  }
}
