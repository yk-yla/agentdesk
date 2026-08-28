import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentRequestContext } from "../../../shared/agentProtocol";
import { encodeCodexRpcError, type JsonObject, type JsonRpcMessage } from "../../../shared/protocol";
import { RpcRequestRegistry } from "../../rpcRequestRegistry";
import type { CodexBackendRuntime } from "./CodexBackend";
import type { AppLogger } from "../../logger";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const APP_SERVER_SHUTDOWN_GRACE_MS = 2_000;
const MAX_TIMED_OUT_REQUESTS = 2_048;
const MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;

const REQUEST_TIMEOUTS_MS: Record<string, number> = {
  initialize: 30_000,
  "model/list": 30_000,
  "skills/list": 60_000,
  "collaborationMode/list": 30_000,
  "account/rateLimits/read": 30_000,
  "mcpServerStatus/list": 60_000,
  "thread/list": 30_000,
  "thread/search": 30_000,
  "thread/delete": 30_000,
  "thread/fork": 60_000,
  "thread/metadata/update": 30_000,
  "thread/name/set": 30_000,
  "thread/goal/set": 30_000,
  "thread/goal/get": 30_000,
  "thread/goal/clear": 30_000,
  "thread/read": 120_000,
  "thread/resume": 60_000,
  "thread/unsubscribe": 30_000,
  "thread/start": 60_000,
  "thread/settings/update": 30_000,
  "turn/start": 60_000,
  "turn/steer": 60_000,
  "turn/interrupt": 30_000,
  "thread/compact/start": 10 * 60_000,
  "review/start": 60_000,
};

export interface CodexAppServerOptions {
  diagnosticLabel?: string;
  command(): string;
  cwd(): string;
  appVersion(): string;
  isRequestBlocked(): boolean;
  isQuitting(): boolean;
  isExitNotificationSuppressed(): boolean;
  terminateTree(child: ChildProcessWithoutNullStreams): Promise<void>;
  inspectMessage(message: JsonRpcMessage, requestMethod?: string): JsonRpcMessage | void;
  env?: NodeJS.ProcessEnv;
  logger?: AppLogger;
}

function spawnSpec(command: string) {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `""${command}" app-server"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command, args: ["app-server"], windowsVerbatimArguments: false };
}

export class CodexAppServer implements CodexBackendRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private requestId = 1;
  private generation = 0;
  private readonly childGenerations = new WeakMap<ChildProcessWithoutNullStreams, number>();
  private readonly requests = new RpcRequestRegistry<ChildProcessWithoutNullStreams>(MAX_TIMED_OUT_REQUESTS);
  private readonly listeners = new Set<(message: JsonRpcMessage) => void>();

  constructor(private readonly options: CodexAppServerOptions) {}

  get isRunning() {
    return Boolean(this.child?.pid && this.child.exitCode === null && !this.child.killed);
  }

  subscribe(listener: (message: JsonRpcMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(message: JsonRpcMessage) {
    this.listeners.forEach((listener) => listener(message));
  }

  async request(method: string, params: JsonObject, context: AgentRequestContext) {
    await this.ensureStarted();
    if (this.options.isRequestBlocked()) throw new Error("Codex CLI 正在更新，请稍后重试。");
    return this.sendRequest(method, params, context);
  }

  async respond(id: number | string, result: JsonObject) {
    await this.ensureStarted();
    if (this.options.isRequestBlocked()) throw new Error("Codex CLI 正在更新，请稍后重试。");
    this.write({ id, result });
  }

  async ensureStarted(options: { allowBlocked?: boolean } = {}) {
    if (this.options.isRequestBlocked() && !options.allowBlocked) throw new Error("Codex CLI 正在更新，请稍后重试。");
    if (this.startPromise) return this.startPromise;

    let child: ChildProcessWithoutNullStreams | null = null;
    let startPromise: Promise<void>;
    startPromise = Promise.resolve().then(async () => {
      if (this.stopPromise) await this.stopPromise;
      if (this.options.isRequestBlocked() && !options.allowBlocked) throw new Error("Codex CLI 正在更新，请稍后重试。");
      const command = this.options.command().trim();
      if (!command) throw new Error("未在 PATH 或 CODEX_DESKTOP_CLI 中找到 Codex CLI。");
      const spec = spawnSpec(command);
      child = spawn(spec.command, spec.args, {
        cwd: this.options.cwd(),
        env: { ...process.env, ...(this.options.env || {}) },
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const generation = ++this.generation;
      this.childGenerations.set(child, generation);
      this.child = child;
      this.options.logger?.log("info", "codex.app_server.spawned", {
        instance: this.options.diagnosticLabel || "default",
        generation,
        appServerProcessId: child.pid,
      });
      this.attachStreams(child);
      this.attachLifecycle(child, startPromise);

      try {
        await this.sendRequest("initialize", {
          clientInfo: { name: "whaty_agentdesk", title: "AgentDesk", version: this.options.appVersion() },
          capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
        }, {}, child);
        if (this.child !== child) throw new Error("Codex app-server stopped during initialization.");
        this.write({ method: "initialized", params: {} }, child);
        this.options.logger?.log("info", "codex.app_server.ready", {
          instance: this.options.diagnosticLabel || "default",
          generation,
          appServerProcessId: child.pid,
        });
        this.publish({ method: "client/ready", params: { workspace: this.options.cwd() } });
      } catch (error) {
        await this.stopChild(child);
        throw error;
      }
    });
    this.startPromise = startPromise;
    void startPromise.catch(() => {
      if (this.startPromise === startPromise) this.startPromise = null;
    });
    return startPromise;
  }

  close() {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) {
      // A request can start the server between the initial state check and
      // the first spawn microtask. Wait for that start to settle, then close
      // the child it created so shutdown cannot leave a late process behind.
      const pendingStart = this.startPromise;
      if (!pendingStart) return Promise.resolve();
      return pendingStart.then(() => {
        const startedChild = this.child;
        return startedChild ? this.stopRunningChild(startedChild) : undefined;
      }, () => undefined);
    }
    return this.stopRunningChild(child);
  }

  private write(message: JsonRpcMessage, child = this.child) {
    if (!child?.stdin.writable || child.exitCode !== null || child.killed) throw new Error("Codex app-server is not available.");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private sendRequest(method: string, params: JsonObject = {}, context: AgentRequestContext = {}, child = this.child): Promise<unknown> {
    if (!child) return Promise.reject(new Error("Codex app-server is not available."));
    const id = this.requestId++;
    return new Promise((resolve, reject) => {
      const timeoutMs = REQUEST_TIMEOUTS_MS[method] ?? DEFAULT_REQUEST_TIMEOUT_MS;
      this.requests.add(id, { child, resolve, reject, method, requestId: context.requestId, sessionId: context.sessionId }, timeoutMs, () => new Error(encodeCodexRpcError({
        method,
        message: `${method} 请求在 ${Math.round(timeoutMs / 1000)} 秒内未响应。`,
        data: { kind: "requestTimeout", backgroundMayContinue: true },
      })));
      this.options.logger?.log("debug", "codex.rpc.sent", {
        requestId: context.requestId,
        rpcId: id,
        method,
        params,
        sessionId: context.sessionId,
        instance: this.options.diagnosticLabel || "default",
        generation: this.childGenerations.get(child),
        appServerProcessId: child.pid,
      });
      try {
        this.write({ id, method, params }, child);
      } catch (error) {
        this.requests.cancel(id, child);
        reject(error);
      }
    });
  }

  private handleMessage(child: ChildProcessWithoutNullStreams, message: JsonRpcMessage) {
    if (message.method && this.child === child) {
      const inspected = this.options.inspectMessage(message) || message;
      this.publish(inspected);
    }
    if (message.method || typeof message.id !== "number") return;
    const tracked = this.requests.takeResponse(message.id, child);
    if (!tracked) return;
    const inspected = this.options.inspectMessage(message, tracked.request.method) || message;
    if (tracked.kind === "late") {
      this.options.logger?.log("warn", "codex.rpc.late_response", { requestId: tracked.request.requestId, rpcId: message.id, method: tracked.request.method, response: inspected });
      if (tracked.request.sessionId) {
        this.publish({ method: "client/late-response", params: { sessionId: tracked.request.sessionId, requestMethod: tracked.request.method, response: inspected } });
      }
      return;
    }
    if (message.error) {
      this.options.logger?.log("error", "codex.rpc.failed", {
        requestId: tracked.request.requestId,
        rpcId: message.id,
        method: tracked.request.method,
        instance: this.options.diagnosticLabel || "default",
        generation: this.childGenerations.get(child),
        appServerProcessId: child.pid,
        error: message.error,
      });
      tracked.request.reject(new Error(encodeCodexRpcError({
        method: tracked.request.method, code: message.error.code, message: message.error.message, data: message.error.data,
      })));
    } else {
      this.options.logger?.log("debug", "codex.rpc.completed", {
        requestId: tracked.request.requestId,
        rpcId: message.id,
        method: tracked.request.method,
        instance: this.options.diagnosticLabel || "default",
        generation: this.childGenerations.get(child),
        appServerProcessId: child.pid,
        result: inspected.result,
      });
      tracked.request.resolve(inspected.result);
    }
  }

  private attachStreams(child: ChildProcessWithoutNullStreams) {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let protocolFailed = false;
    const failProtocol = () => {
      if (protocolFailed) return;
      protocolFailed = true;
      this.publish({ method: "client/server-exited", params: { reason: "protocolLimit", message: "Codex app-server 返回了超过 16 MB 的单条消息，连接已重置。" } });
      void this.stopRunningChild(child);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (protocolFailed) return;
      stdoutBuffer += chunk;
      if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_JSONL_LINE_BYTES && !stdoutBuffer.includes("\n")) return failProtocol();
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES) return failProtocol();
        if (line.trim()) {
          try {
            this.handleMessage(child, JSON.parse(line) as JsonRpcMessage);
          } catch {
            this.publish({ method: "client/log", params: { level: "warn", message: line.slice(0, 8 * 1024) } });
          }
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
      if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_JSONL_LINE_BYTES) failProtocol();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer = `${stderrBuffer}${chunk}`.slice(-64 * 1024);
      let newlineIndex = stderrBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stderrBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
        if (line) this.publish({ method: "client/log", params: { level: "stderr", message: line.slice(0, 8 * 1024) } });
        newlineIndex = stderrBuffer.indexOf("\n");
      }
    });
  }

  private attachLifecycle(child: ChildProcessWithoutNullStreams, startPromise: Promise<void>) {
    let terminated = false;
    const handleTermination = (error: Error, code?: number | null, signal?: NodeJS.Signals | null, source = "exit") => {
      if (terminated) return;
      terminated = true;
      const wasActive = this.child === child;
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      if (wasActive) this.child = null;
      if (this.startPromise === startPromise) this.startPromise = null;
      this.requests.reject(error, child);
      this.options.logger?.log(wasActive && !this.options.isQuitting() ? "warn" : "info", "codex.app_server.exited", {
        instance: this.options.diagnosticLabel || "default",
        generation: this.childGenerations.get(child),
        appServerProcessId: child.pid,
        source,
        code,
        signal,
        wasActive,
        quitting: this.options.isQuitting(),
        error: { name: error.name, message: error.message },
      });
      if (wasActive && !this.options.isQuitting() && !this.options.isExitNotificationSuppressed()) {
        this.publish({ method: "client/server-exited", params: { code } });
      }
    };
    child.once("error", (error) => handleTermination(error, null, null, "error"));
    child.once("exit", (code, signal) => handleTermination(new Error(`Codex app-server exited with code ${code ?? "unknown"}.`), code, signal, "exit"));
  }

  private stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.child === child) this.child = null;
    if (this.startPromise) this.startPromise = null;
    if (!child.pid || child.killed || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let finished = false;
      let forceTimer: NodeJS.Timeout | null = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (forceTimer) clearTimeout(forceTimer);
        resolve();
      };
      child.once("exit", finish);
      forceTimer = setTimeout(() => void this.options.terminateTree(child).finally(finish), APP_SERVER_SHUTDOWN_GRACE_MS);
      try { child.stdin.end(); } catch { void this.options.terminateTree(child).finally(finish); }
    });
  }

  private stopRunningChild(child: ChildProcessWithoutNullStreams) {
    if (this.stopPromise) return this.stopPromise;
    const stopping = this.stopChild(child);
    this.stopPromise = stopping;
    void stopping.finally(() => {
      if (this.stopPromise === stopping) this.stopPromise = null;
    });
    return stopping;
  }
}
