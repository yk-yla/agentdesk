import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as pty from "node-pty";
import type { AgentProvider } from "../shared/agentProtocol";
import type { TerminalEvent, TerminalInputRequest, TerminalResizeRequest, TerminalSessionCommand, TerminalSessionInfo, TerminalSessionRequest } from "../shared/terminalProtocol";
import { canonicalPath } from "./localPathPolicy";
import { resolveExecutableFromPath } from "./executablePath";
import { managedClaudeExecutablePath } from "./providers/claude/claudeUpdater";
import { NativeSessionOwnershipRegistry } from "./agent/nativeSessionOwnershipRegistry";
import { terminateWindowsProcessTree } from "./processSupervisor";

const MIN_TERMINAL_COLS = 20;
const MAX_TERMINAL_COLS = 500;
const MIN_TERMINAL_ROWS = 4;
const MAX_TERMINAL_ROWS = 200;
const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES = 1024 * 1024;
export const MAX_ACTIVE_TERMINALS = 8;
export const MAX_TERMINAL_EVENT_BYTES = 64 * 1024;

interface TerminalCommand {
  executable: string;
  args: string[];
  wrapper?: "cmd";
  wrapperTarget?: string;
}

const claimedConhostPids = new Set<number>();

interface TerminalRecord {
  info: TerminalSessionInfo;
  pty: pty.IPty;
  startedAt: number;
  readyAt?: number;
  outputChunks: Buffer[];
  outputBytes: number;
  closing: boolean;
  closePromise?: Promise<void>;
  closeResolve?: () => void;
  closeReject?: (error: unknown) => void;
  finalized: boolean;
  forceTerminating: boolean;
  conhostPids: number[];
  conhostCapture?: Promise<void>;
}

export interface TerminalSessionManagerOptions {
  isWorkspaceAuthorized(cwd: string): boolean;
  emit(event: TerminalEvent): void;
  nativeOwnership?: NativeSessionOwnershipRegistry;
  assertNativeSessionAuthorized?(provider: AgentProvider, nativeSessionId: string, cwd: string): void;
  log?(level: "info" | "warn" | "error", event: string, details?: Record<string, unknown>): void;
  spawn?: typeof pty.spawn;
  resolveCommand?(provider: AgentProvider): TerminalCommand;
  terminateProcessTree?(pid: number): Promise<void>;
  closeGraceMs?: number;
  captureConhostPids?(startedAt: number, shellPid?: number): Promise<number[]>;
}

function boundedDimension(value: unknown, fallback: number, min: number, max: number) {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.max(min, Math.min(max, Number(value)));
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function cleanEnvironment(provider?: AgentProvider) {
  const env: Record<string, string | undefined> = { ...process.env };
  // The embedded PTY is an interactive color-capable terminal. Do not let a
  // host-level NO_COLOR setting (often used for logs/CI) disable the TUI's
  // ANSI output, and opt in to color for CLIs that honor the common flags.
  for (const key of ["CODEX_CI", "CODEX_MANAGED_BY_NPM", "CODEX_MANAGED_PACKAGE_ROOT", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_TUI_EXEC_HISTORY", "CLAUDE_CODE_NO_FLICKER", "CLAUDE_CODE_CHILD_SESSION", "NO_COLOR"]) delete env[key];
  if (provider === "codex") {
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_API_KEY"]) delete env[key];
  } else if (provider === "claude") {
    for (const key of ["CODEX_API_KEY", "OPENAI_API_KEY"]) delete env[key];
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "AgentDesk";
  env.CLICOLOR = "1";
  env.CLICOLOR_FORCE = "1";
  env.FORCE_COLOR = "1";
  // Claude Code otherwise owns an alternate screen and its own virtual
  // viewport. Both keep xterm from accumulating a normal scrollback buffer,
  // so the embedded terminal cannot show the same history as a regular
  // terminal window. Keep these provider-specific settings isolated.
  if (provider === "claude") {
    env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1";
    env.CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL = "1";
  }
  return env;
}

function configuredCommand(value: string, args: string[] = []): TerminalCommand {
  const executable = value.trim();
  if (/\.(?:cmd|bat)$/i.test(executable)) {
    const shell = process.env.ComSpec || resolveExecutableFromPath("cmd.exe") || "cmd.exe";
    return { executable: shell, args, wrapper: "cmd", wrapperTarget: executable };
  }
  return { executable, args };
}

function commandArgs(command: TerminalCommand, extra: string[]) {
  if (command.wrapper === "cmd") {
    // node-pty builds the Windows command line from each argument. Passing a
    // pre-quoted `/c` command as one argument makes those quotes literal
    // (`\"path\" is not recognized`). Keep the target and its arguments
    // separate so node-pty performs the required quoting exactly once.
    return ["/d", "/s", "/c", command.wrapperTarget || command.executable, ...extra, ...command.args];
  }
  return [...extra, ...command.args];
}

function headlessConhostPids(startedAt: number, shellPid?: number) {
  if (process.platform !== "win32") return Promise.resolve([] as number[]);
  // The Electron main PID is shared by every node-pty instance and cannot
  // identify one ConPTY. Only a direct PTY parent is safe to associate.
  const parentId = Number.isSafeInteger(shellPid) ? Math.trunc(shellPid as number) : 0;
  if (parentId <= 0) return Promise.resolve([] as number[]);
  const script = `$parent = ${parentId}; $lower = ${Math.max(0, Math.trunc(startedAt))}; $upper = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); $items = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'conhost.exe' -and $_.CommandLine -like '*--headless*' -and $parent -eq [int]$_.ParentProcessId }); $items | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId; StartedAt = [DateTimeOffset]([System.Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate)).ToUnixTimeMilliseconds() } } | Where-Object { $_.StartedAt -ge $lower -and $_.StartedAt -le $upper } | ConvertTo-Json -Compress`;
  return new Promise<number[]>((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const finish = (value: number[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish([]); }, 1_500);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-64 * 1024); });
    child.once("error", () => finish([]));
    child.once("exit", () => {
      try {
        const parsed = JSON.parse(stdout || "null") as unknown;
        const items = Array.isArray(parsed) ? parsed : [parsed];
        finish(items.map((item) => {
          if (!item || typeof item !== "object") return 0;
          const value = item as { ProcessId?: unknown; StartedAt?: unknown };
          return Number(value.StartedAt) >= startedAt ? Number(value.ProcessId) : 0;
        }).filter((pid) => Number.isSafeInteger(pid) && pid > 0));
      } catch {
        finish([]);
      }
    });
  });
}

function commandFor(provider: AgentProvider): TerminalCommand {
  if (provider === "claude") {
    // The user's saved `tui` preference may be fullscreen. This is a
    // session-only command-line setting, so it keeps the embedded terminal
    // on Claude's classic renderer without changing the user's global config.
    const classicRendererArgs = ["--settings", JSON.stringify({ tui: "default" })];
    const configured = process.env.CLAUDE_CODE_EXECUTABLE?.trim();
    if (configured) return configuredCommand(configured, classicRendererArgs);
    // npm installs on Windows expose Claude Code through a .cmd shim. The
    // shim is a valid terminal command, but it is not a managed update target.
    const npmShim = resolveExecutableFromPath(process.platform === "win32" ? "claude.cmd" : "claude");
    if (npmShim) return configuredCommand(npmShim, classicRendererArgs);
    const executable = managedClaudeExecutablePath();
    return configuredCommand(executable, classicRendererArgs);
  }
  const configured = process.env.CODEX_TERMINAL_CLI?.trim();
  if (configured) return configuredCommand(configured, ["--no-alt-screen"]);
  const executable = resolveExecutableFromPath("codex.cmd") || resolveExecutableFromPath("codex") || "";
  return configuredCommand(executable, ["--no-alt-screen"]);
}

function resumeArgs(provider: AgentProvider, nativeSessionId: string | undefined) {
  if (!nativeSessionId) return [] as string[];
  return provider === "claude" ? ["--resume", nativeSessionId] : ["resume", nativeSessionId];
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalRecord>();
  private readonly generations = new Map<string, number>();
  private readonly blockedProviders = new Set<AgentProvider>();
  private shutdownRequested = false;

  constructor(private readonly options: TerminalSessionManagerOptions) {}

  private log(level: "info" | "warn" | "error", event: string, details?: Record<string, unknown>) {
    // 日志属于诊断旁路，任何日志实现异常都不能影响终端输入、输出或关闭。
    try { this.options.log?.(level, event, details); } catch { /* logging must never affect terminal I/O */ }
  }

  private logStartFailure(request: TerminalSessionRequest, reason: string) {
    const sessionId = stringValue(request.sessionId).trim().slice(0, 160);
    this.log("warn", "terminal.start.failed", { provider: request.provider, ...(sessionId ? { sessionId } : {}), reason });
  }

  setProviderUpdateBlocked(provider: AgentProvider, blocked: boolean) {
    if (blocked) this.blockedProviders.add(provider);
    else this.blockedProviders.delete(provider);
  }

  start(request: TerminalSessionRequest): TerminalSessionInfo {
    const sessionId = stringValue(request.sessionId).trim();
    const cwd = canonicalPath(stringValue(request.cwd));
    if (!sessionId || sessionId.length > 160) { this.logStartFailure(request, "invalid-session-id"); throw new Error("终端会话 ID 无效。"); }
    if (this.shutdownRequested) { this.logStartFailure(request, "application-shutting-down"); throw new Error("应用正在关闭，暂不能启动终端。"); }
    if (this.blockedProviders.has(request.provider)) { this.logStartFailure(request, "provider-update-blocked"); throw new Error(`${request.provider === "claude" ? "Claude Code" : "Codex CLI"} 正在更新，暂不能启动终端。`); }
    if (!cwd || !existsSync(cwd) || !this.options.isWorkspaceAuthorized(cwd)) { this.logStartFailure(request, "workspace-not-authorized"); throw new Error("终端工作区未经过主进程授权。"); }
    if (request.nativeSessionId) {
      try {
        this.options.assertNativeSessionAuthorized?.(request.provider, request.nativeSessionId, cwd);
        this.options.nativeOwnership?.assertAvailable(request.provider, request.nativeSessionId, sessionId, "terminal");
      } catch (error) {
        this.logStartFailure(request, "native-session-not-authorized");
        throw error;
      }
    }
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.info.provider !== request.provider || existing.info.cwd !== cwd || (existing.info.nativeSessionId || "") !== (request.nativeSessionId || "")) { this.logStartFailure(request, "session-ownership-mismatch"); throw new Error("终端会话归属不匹配。"); }
      this.log("info", "terminal.reattached", { provider: existing.info.provider, sessionId, generation: existing.info.generation, pid: existing.info.pid, status: existing.info.status, bufferedOutputBytes: existing.outputBytes });
      queueMicrotask(() => {
        this.emit({ type: "started", info: existing.info });
        if (existing.outputBytes) this.emitOutput(existing.info.provider, sessionId, existing.info.generation, Buffer.concat(existing.outputChunks, existing.outputBytes).toString("utf8"));
        if (existing.info.status === "running") this.emit({ type: "ready", info: existing.info });
      });
      return existing.info;
    }
    if (this.sessions.size >= MAX_ACTIVE_TERMINALS) { this.logStartFailure(request, "active-terminal-limit"); throw new Error(`活动终端数量已达到上限（${MAX_ACTIVE_TERMINALS} 个）。请先关闭其他终端。`); }
    let command: TerminalCommand;
    try {
      command = this.options.resolveCommand?.(request.provider) || commandFor(request.provider);
    } catch (error) {
      this.logStartFailure(request, "command-resolution-failed");
      throw error;
    }
    if (!command.executable || !existsSync(command.executable) || (command.wrapperTarget && !existsSync(command.wrapperTarget))) { this.logStartFailure(request, "executable-not-found"); throw new Error((request.provider === "claude" ? "Claude Code" : "Codex CLI") + " 可执行文件未找到。"); }
    const generation = (this.generations.get(sessionId) || 0) + 1;
    this.generations.set(sessionId, generation);
    const cols = boundedDimension(request.cols, 100, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS);
    const rows = boundedDimension(request.rows, 32, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS);
    const startedAt = Date.now();
    let child: pty.IPty;
    try {
      child = (this.options.spawn || pty.spawn)(command.executable, commandArgs(command, request.resume ? resumeArgs(request.provider, request.nativeSessionId) : []), {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: cleanEnvironment(request.provider),
        useConpty: process.platform === "win32",
      });
    } catch (error) {
      this.logStartFailure(request, "pty-spawn-threw");
      throw error;
    }
    const info: TerminalSessionInfo = {
      provider: request.provider,
      sessionId,
      cwd,
      ...(request.nativeSessionId ? { nativeSessionId: request.nativeSessionId } : {}),
      generation,
      pid: child.pid,
      status: "starting",
    };
    const record: TerminalRecord = { info, pty: child, startedAt, outputChunks: [], outputBytes: 0, closing: false, finalized: false, forceTerminating: false, conhostPids: [] };
    this.sessions.set(sessionId, record);
    record.conhostCapture = (this.options.captureConhostPids || headlessConhostPids)(startedAt, child.pid).then((pids) => {
      if (record.finalized) return;
      record.conhostPids = pids.filter((pid) => {
        if (claimedConhostPids.has(pid)) return false;
        claimedConhostPids.add(pid);
        return true;
      });
    }).catch(() => undefined);
    if (request.nativeSessionId) this.options.nativeOwnership?.claim(request.provider, request.nativeSessionId, sessionId, "terminal");
    this.log("info", "terminal.started", { provider: request.provider, sessionId, generation, pid: child.pid, cols, rows, resumed: request.resume === true, hasNativeSession: Boolean(request.nativeSessionId) });
    this.emit({ type: "started", info });
    child.onData((data) => {
      const current = this.sessions.get(sessionId);
      if (!current || current.info.generation !== generation) return;
      const chunk = Buffer.from(data, "utf8");
      if (chunk.length) {
        const boundedChunk = chunk.length > MAX_TERMINAL_OUTPUT_BYTES ? chunk.subarray(chunk.length - MAX_TERMINAL_OUTPUT_BYTES) : chunk;
        current.outputChunks.push(boundedChunk);
        current.outputBytes += boundedChunk.length;
        while (current.outputBytes > MAX_TERMINAL_OUTPUT_BYTES && current.outputChunks.length) {
          const first = current.outputChunks[0];
          const remove = Math.min(current.outputBytes - MAX_TERMINAL_OUTPUT_BYTES, first.length);
          if (remove === first.length) current.outputChunks.shift();
          else current.outputChunks[0] = first.subarray(remove);
          current.outputBytes -= remove;
        }
      }
      if (current.info.status === "starting") {
        current.readyAt = Date.now();
        current.info = { ...current.info, status: "running" };
        this.log("info", "terminal.ready", { provider: request.provider, sessionId, generation, pid: current.info.pid, firstOutputLatencyMs: current.readyAt - current.startedAt });
        this.emit({ type: "ready", info: current.info });
      }
      if (data) this.emitOutput(request.provider, sessionId, generation, data);
    });
    child.onExit(({ exitCode, signal }) => {
      const current = this.sessions.get(sessionId);
      if (!current || current.info.generation !== generation) return;
      this.finalize(current, exitCode, signal);
    });
    return info;
  }

  write(request: TerminalInputRequest) {
    const record = this.require(request.sessionId, request.generation);
    if (Buffer.byteLength(request.data, "utf8") > MAX_TERMINAL_INPUT_BYTES) throw new Error("终端输入过大。");
    record.pty.write(request.data);
  }

  resize(request: TerminalResizeRequest) {
    const record = this.require(request.sessionId, request.generation);
    record.pty.resize(
      boundedDimension(request.cols, record.pty.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS),
      boundedDimension(request.rows, record.pty.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS),
    );
  }

  interrupt(command: TerminalSessionCommand) {
    const record = this.require(command.sessionId, command.generation);
    record.pty.write("\x03");
  }

  async close(command: TerminalSessionCommand) {
    const record = this.sessions.get(command.sessionId);
    if (!record) return;
    if (command.generation !== undefined && command.generation !== record.info.generation) throw new Error("终端会话不存在或已过期。");
    if (record.closePromise) return record.closePromise;
    const statusBeforeClose = record.info.status;
    record.closing = true;
    this.log("info", "terminal.close.requested", { provider: record.info.provider, sessionId: record.info.sessionId, generation: record.info.generation, pid: record.info.pid, status: statusBeforeClose });
    record.info = { ...record.info, status: "closing" };
    this.emit({ type: "started", info: record.info });
    record.closePromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        record.forceTerminating = true;
        this.log("warn", "terminal.close.forced", { provider: record.info.provider, sessionId: record.info.sessionId, generation: record.info.generation, pid: record.info.pid });
        void this.forceTerminate(record).then(() => {
          // A successful process-tree terminator is sufficient evidence that the
          // fallback cleanup completed even when node-pty does not emit onExit.
          this.finalize(record, -1);
          this.resolveClose(record);
        }).catch((error) => {
          record.forceTerminating = false;
          record.info = { ...record.info, status: "running" };
          record.closeReject?.(error);
        });
      }, this.options.closeGraceMs ?? 2_000);
      record.closeResolve = () => { clearTimeout(timer); resolve(); };
      record.closeReject = (error) => {
        clearTimeout(timer);
        record.closePromise = undefined;
        record.closeResolve = undefined;
        record.closeReject = undefined;
        this.log("error", "terminal.close.failed", { provider: record.info.provider, sessionId: record.info.sessionId, generation: record.info.generation, pid: record.info.pid, errorName: error instanceof Error ? error.name : "UnknownError" });
        this.emit({ type: "error", provider: record.info.provider, sessionId: record.info.sessionId, generation: record.info.generation, message: error instanceof Error ? error.message : "关闭终端失败。" });
        reject(error);
      };
      try {
        if (record.info.provider === "claude") {
          record.pty.write("\x03");
          setTimeout(() => { try { record.pty.write("\x03"); } catch { /* already gone */ } }, 200);
        } else {
          record.pty.write("\x03");
        }
      } catch (error) {
        this.log("warn", "terminal.close.interrupt_failed", { provider: record.info.provider, sessionId: record.info.sessionId, generation: record.info.generation, pid: record.info.pid, error: error instanceof Error ? error.name : "UnknownError" });
      }
    });
    return record.closePromise;
  }

  async closeAll() {
    this.shutdownRequested = true;
    await this.closeRecords([...this.sessions.values()], "终端");
  }

  get activeCount() { return this.sessions.size; }

  async closeProvider(provider: AgentProvider) {
    await this.closeRecords([...this.sessions.values()].filter((record) => record.info.provider === provider), provider === "claude" ? "Claude Code 终端" : "Codex 终端");
  }

  private async closeRecords(records: TerminalRecord[], label: string) {
    const results = await Promise.allSettled(records.map((record) => this.close({ sessionId: record.info.sessionId, generation: record.info.generation })));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    const remaining = records.filter((record) => this.sessions.get(record.info.sessionId) === record);
    if (!failures.length && !remaining.length) return;
    const reasons = failures.map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    if (remaining.length) reasons.push(`${remaining.length} 个终端仍未清理`);
    throw new Error(`${label}清理失败：${reasons.join("；")}`);
  }

  private require(sessionId: string, generation?: number) {
    const record = this.sessions.get(sessionId);
    if (!record || (generation !== undefined && generation !== record.info.generation)) throw new Error("终端会话不存在或已过期。");
    return record;
  }

  private finalize(record: TerminalRecord, exitCode: number, signal?: number) {
    if (record.finalized) return;
    record.finalized = true;
    const { provider, sessionId, generation } = record.info;
    if (this.sessions.get(sessionId) === record) this.sessions.delete(sessionId);
    for (const pid of record.conhostPids) claimedConhostPids.delete(pid);
    if (record.info.nativeSessionId) this.options.nativeOwnership?.release(provider, record.info.nativeSessionId, sessionId, "terminal");
    record.info = { ...record.info, status: "exited" };
    this.log("info", "terminal.exited", { provider, sessionId, generation, pid: record.info.pid, exitCode, signal: signal ?? null, closing: record.closing, forced: record.forceTerminating, lifetimeMs: Math.max(0, Date.now() - record.startedAt) });
    this.emit({ type: "exited", provider, sessionId, generation, info: record.info, exitCode, ...(signal ? { signal } : {}) });
    if (!record.forceTerminating) this.resolveClose(record);
  }

  private resolveClose(record: TerminalRecord) {
    const resolve = record.closeResolve;
    record.closeResolve = undefined;
    record.closeReject = undefined;
    resolve?.();
  }

  private emitOutput(provider: AgentProvider, sessionId: string, generation: number, data: string) {
    const decoder = new StringDecoder("utf8");
    const bytes = Buffer.from(data, "utf8");
    for (let offset = 0; offset < bytes.length; offset += MAX_TERMINAL_EVENT_BYTES) {
      const chunk = decoder.write(bytes.subarray(offset, offset + MAX_TERMINAL_EVENT_BYTES));
      if (chunk) this.emit({ type: "output", provider, sessionId, generation, data: chunk });
    }
    const tail = decoder.end();
    if (tail) this.emit({ type: "output", provider, sessionId, generation, data: tail });
  }

  private async forceTerminate(record: TerminalRecord) {
    if (process.platform === "win32") {
      await record.conhostCapture;
      await (this.options.terminateProcessTree || terminateWindowsProcessTree)(record.info.pid);
      for (const pid of record.conhostPids) {
        await (this.options.terminateProcessTree || terminateWindowsProcessTree)(pid);
      }
    }
    try { record.pty.kill(); } catch { /* already gone */ }
  }

  private emit(event: Partial<TerminalEvent> & Pick<TerminalEvent, "type">) {
    const provider = event.provider || event.info?.provider;
    const sessionId = event.sessionId || event.info?.sessionId;
    const generation = event.generation || event.info?.generation;
    if (!provider || !sessionId || !generation) throw new Error("终端事件归属无效。");
    this.options.emit({ ...event, provider, sessionId, generation, receivedAt: event.receivedAt || Date.now() });
  }
}
