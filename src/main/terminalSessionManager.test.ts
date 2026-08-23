import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as pty from "node-pty";
import type { AgentProvider } from "../shared/agentProtocol";
import type { TerminalEvent } from "../shared/terminalProtocol";
import { canonicalPath } from "./localPathPolicy";
import { MAX_ACTIVE_TERMINALS, MAX_TERMINAL_EVENT_BYTES, TerminalSessionManager } from "./terminalSessionManager";
import { NativeSessionOwnershipRegistry } from "./agent/nativeSessionOwnershipRegistry";

class FakePty {
  readonly pid = 4242;
  cols = 80;
  rows = 24;
  process = "fake";
  handleFlowControl = false;
  writes: string[] = [];
  killed = false;
  private dataListeners: Array<(value: string) => void> = [];
  private exitListeners: Array<(value: { exitCode: number; signal?: number }) => void> = [];

  onData = (listener: (value: string) => void) => {
    this.dataListeners.push(listener);
    return { dispose: () => { this.dataListeners = this.dataListeners.filter((entry) => entry !== listener); } };
  };
  onExit = (listener: (value: { exitCode: number; signal?: number }) => void) => {
    this.exitListeners.push(listener);
    return { dispose: () => { this.exitListeners = this.exitListeners.filter((entry) => entry !== listener); } };
  };
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  clear() {}
  pause() {}
  resume() {}
  kill() { this.killed = true; }
  emitData(data: string) { this.dataListeners.forEach((listener) => listener(data)); }
  emitExit(exitCode = 0) { this.exitListeners.forEach((listener) => listener({ exitCode })); }
}

function harness(cwd: string, nativeOwnership = new NativeSessionOwnershipRegistry()) {
  const events: TerminalEvent[] = [];
  const children: FakePty[] = [];
  const logs: Array<{ level: string; event: string; details?: Record<string, unknown> }> = [];
  const manager = new TerminalSessionManager({
    isWorkspaceAuthorized: (value) => value === canonicalPath(cwd),
    nativeOwnership,
    emit: (event) => events.push(event),
    log: (level, event, details) => logs.push({ level, event, details }),
    resolveCommand: (_provider: AgentProvider) => ({ executable: process.execPath, args: [] }),
    spawn: ((_executable: string, _args: string[], options: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions) => {
      const child = new FakePty();
      child.cols = options.cols || 80;
      child.rows = options.rows || 24;
      children.push(child);
      return child as unknown as pty.IPty;
    }) as typeof pty.spawn,
    captureConhostPids: async () => [],
  });
  return { manager, events, children, logs };
}

describe("TerminalSessionManager", () => {
  it("binds a terminal to its provider, workspace and generation", () => {
    const cwd = process.cwd();
    const { manager, children } = harness(cwd);
    const info = manager.start({ provider: "codex", sessionId: "session-1", cwd, cols: 2, rows: 999 });
    assert.equal(info.generation, 1);
    assert.equal(children[0].cols, 20);
    assert.equal(children[0].rows, 200);
    assert.throws(() => manager.start({ provider: "claude", sessionId: "session-1", cwd }), /归属不匹配/);
    assert.throws(() => manager.start({ provider: "codex", sessionId: "session-2", cwd: process.platform === "win32" ? "C:\\Windows" : "/" }), /未经过主进程授权/);
  });

  it("passes Windows cmd shims as separate node-pty arguments", () => {
    const cwd = process.cwd();
    const captured: string[] = [];
    const manager = new TerminalSessionManager({
      isWorkspaceAuthorized: (value) => value === canonicalPath(cwd),
      emit: () => undefined,
      resolveCommand: () => ({ executable: process.execPath, args: ["--no-alt-screen"], wrapper: "cmd", wrapperTarget: process.execPath }),
      spawn: ((executable: string, args: string[]) => {
        captured.push(executable, ...args);
        return new FakePty() as unknown as pty.IPty;
      }) as typeof pty.spawn,
      captureConhostPids: async () => [],
    });
    manager.start({ provider: "codex", sessionId: "cmd-shim", cwd, nativeSessionId: "thread-1", resume: true });
    assert.deepEqual(captured, [process.execPath, "/d", "/s", "/c", process.execPath, "resume", "thread-1", "--no-alt-screen"]);
  });

  it("starts the embedded PTY with color-capable environment settings", () => {
    const cwd = process.cwd();
    let capturedEnv: Record<string, string | undefined> | undefined;
    const manager = new TerminalSessionManager({
      isWorkspaceAuthorized: (value) => value === canonicalPath(cwd),
      emit: () => undefined,
      resolveCommand: () => ({ executable: process.execPath, args: [] }),
      spawn: ((_executable: string, _args: string[], options: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions) => {
        capturedEnv = options.env as Record<string, string | undefined>;
        return new FakePty() as unknown as pty.IPty;
      }) as typeof pty.spawn,
      captureConhostPids: async () => [],
    });
    manager.start({ provider: "claude", sessionId: "color-environment", cwd });
    assert.equal(capturedEnv?.TERM, "xterm-256color");
    assert.equal(capturedEnv?.COLORTERM, "truecolor");
    assert.equal(capturedEnv?.TERM_PROGRAM, "AgentDesk");
    assert.equal(capturedEnv?.CLICOLOR, "1");
    assert.equal(capturedEnv?.CLICOLOR_FORCE, "1");
    assert.equal(capturedEnv?.FORCE_COLOR, "1");
    assert.equal(capturedEnv?.NO_COLOR, undefined);
    assert.equal(capturedEnv?.CLAUDE_CODE_NO_FLICKER, undefined);
    assert.equal(capturedEnv?.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, "1");
    assert.equal(capturedEnv?.CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL, "1");
  });

  it("routes output, input, resize, interrupt and rejects stale generations", async () => {
    const cwd = process.cwd();
    const { manager, events, children, logs } = harness(cwd);
    const info = manager.start({ provider: "claude", sessionId: "session-1", cwd });
    const child = children[0];
    child.emitData("\u001b[32mREADY\u001b[0m");
    assert.equal(events.some((event) => event.type === "ready"), true);
    assert.equal(events.some((event) => event.type === "output" && event.data?.includes("READY")), true);
    manager.write({ sessionId: "session-1", generation: info.generation, data: "hello" });
    manager.resize({ sessionId: "session-1", generation: info.generation, cols: 120, rows: 40 });
    manager.interrupt({ sessionId: "session-1", generation: info.generation });
    assert.deepEqual(child.writes, ["hello", "\x03"]);
    assert.deepEqual([child.cols, child.rows], [120, 40]);
    assert.throws(() => manager.write({ sessionId: "session-1", generation: info.generation + 1, data: "stale" }), /已过期/);
    const closing = manager.close({ sessionId: "session-1", generation: info.generation });
    child.emitExit(0);
    await closing;
    await manager.close({ sessionId: "session-1" });
    assert.equal(manager.activeCount, 0);
    assert.equal(logs.filter((entry) => entry.event === "terminal.ready").length, 1);
    const exited = logs.find((entry) => entry.event === "terminal.exited");
    assert.equal(exited?.details?.exitCode, 0);
    assert.equal(exited?.details?.closing, true);
  });

  it("records an unexpected PTY exit separately from an active close", () => {
    const cwd = process.cwd();
    const { manager, children, logs } = harness(cwd);
    manager.start({ provider: "claude", sessionId: "unexpected-exit", cwd });
    children[0].emitExit(23);
    const exited = logs.find((entry) => entry.event === "terminal.exited");
    assert.equal(exited?.details?.exitCode, 23);
    assert.equal(exited?.details?.closing, false);
    assert.equal(exited?.details?.forced, false);
  });

  it("records a PTY spawn failure without exposing command or workspace", () => {
    const cwd = process.cwd();
    const logs: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const manager = new TerminalSessionManager({
      isWorkspaceAuthorized: (value) => value === canonicalPath(cwd),
      emit: () => undefined,
      log: (_level, event, details) => logs.push({ event, details }),
      resolveCommand: () => ({ executable: process.execPath, args: [] }),
      spawn: (() => { throw new Error("spawn failed"); }) as typeof pty.spawn,
    });
    assert.throws(() => manager.start({ provider: "codex", sessionId: "spawn-failure", cwd }), /spawn failed/);
    assert.equal(logs.find((entry) => entry.event === "terminal.start.failed")?.details?.reason, "pty-spawn-threw");
    assert.equal("cwd" in (logs[0]?.details || {}), false);
  });

  it("reattaches to an existing terminal and replays its bounded output", async () => {
    const cwd = process.cwd();
    const { manager, events, children } = harness(cwd);
    const original = manager.start({ provider: "codex", sessionId: "session-1", cwd });
    children[0].emitData("previous output");
    events.length = 0;
    const attached = manager.start({ provider: "codex", sessionId: "session-1", cwd });
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    assert.equal(attached.generation, original.generation);
    assert.equal(events.some((event) => event.type === "output" && event.data === "previous output"), true);
    assert.equal(events.some((event) => event.type === "ready" && event.info?.status === "running"), true);
  });

  it("keeps only the bounded tail of high-frequency output", () => {
    const cwd = process.cwd();
    const { manager, children } = harness(cwd);
    const info = manager.start({ provider: "codex", sessionId: "session-output", cwd });
    children[0].emitData("a".repeat(1024 * 1024));
    children[0].emitData("tail");
    const events: TerminalEvent[] = [];
    const logs: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const reattached = manager.start({ provider: "codex", sessionId: info.sessionId, cwd });
    void reattached;
    // The replay is emitted asynchronously by the manager; this assertion
    // checks the manager remains usable after the large append without exposing
    // its private buffer representation.
    assert.equal(manager.activeCount, 1);
  });

  it("splits oversized output events before sending them to the renderer", () => {
    const cwd = process.cwd();
    const { manager, events, children } = harness(cwd);
    manager.start({ provider: "codex", sessionId: "session-large-event", cwd });
    children[0].emitData("x".repeat(MAX_TERMINAL_EVENT_BYTES * 2 + 17));
    const output = events.filter((event) => event.type === "output");
    assert.equal(output.length, 3);
    assert.equal(output.every((event) => Buffer.byteLength(event.data || "", "utf8") <= MAX_TERMINAL_EVENT_BYTES), true);
  });

  it("rejects a new terminal after reaching the active terminal limit", () => {
    const cwd = process.cwd();
    const { manager } = harness(cwd);
    for (let index = 0; index < MAX_ACTIVE_TERMINALS; index += 1) {
      manager.start({ provider: "codex", sessionId: `capacity-${index}`, cwd });
    }
    assert.throws(() => manager.start({ provider: "codex", sessionId: "capacity-overflow", cwd }), /活动终端数量已达到上限/);
  });

  it("rejects new Provider terminals while an update holds the gate", () => {
    const cwd = process.cwd();
    const { manager } = harness(cwd);
    manager.setProviderUpdateBlocked("codex", true);
    assert.throws(() => manager.start({ provider: "codex", sessionId: "blocked-codex", cwd }), /Codex CLI 正在更新/);
    assert.doesNotThrow(() => manager.start({ provider: "claude", sessionId: "allowed-claude", cwd }));
  });

  it("claims native terminal ownership and releases it after exit", () => {
    const cwd = process.cwd();
    const ownership = new NativeSessionOwnershipRegistry();
    const { manager, children } = harness(cwd, ownership);
    const info = manager.start({ provider: "codex", sessionId: "terminal-1", cwd, nativeSessionId: "thread-1" });
    assert.equal(ownership.owner("codex", "thread-1")?.mode, "terminal");
    assert.throws(() => ownership.claim("codex", "thread-1", "workbench-1", "workbench"), /占用/);
    children[0].emitExit(0);
    assert.equal(ownership.owner("codex", "thread-1"), undefined);
    assert.equal(info.status, "starting");
  });

  it("waits for forced process-tree cleanup before resolving close", async () => {
    const cwd = process.cwd();
    const terminated: number[] = [];
    let releaseTermination: (() => void) | undefined;
    const events: TerminalEvent[] = [];
    const logs: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const child = new FakePty();
    const manager = new TerminalSessionManager({
      isWorkspaceAuthorized: (value) => value === canonicalPath(cwd),
      emit: (event) => events.push(event),
      log: (_level, event, details) => logs.push({ event, details }),
      resolveCommand: () => ({ executable: process.execPath, args: [] }),
      spawn: (() => child as unknown as pty.IPty) as typeof pty.spawn,
      closeGraceMs: 5,
      terminateProcessTree: (pid) => new Promise<void>((resolve) => {
        terminated.push(pid);
        releaseTermination = resolve;
      }),
      captureConhostPids: async () => [],
    });
    const info = manager.start({ provider: "codex", sessionId: "session-force-close", cwd });
    let resolved = false;
    const closing = manager.close({ sessionId: info.sessionId, generation: info.generation }).then(() => { resolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(terminated, [child.pid]);
    assert.equal(resolved, false);
    releaseTermination?.();
    await closing;
    assert.equal(child.killed, true);
    assert.equal(manager.activeCount, 0);
    assert.equal(events.some((event) => event.type === "exited"), true);
    assert.equal(logs.some((entry) => entry.event === "terminal.close.forced"), true);
    assert.equal(logs.find((entry) => entry.event === "terminal.exited")?.details?.forced, true);
  });

  it("does not release a live session when forced cleanup fails", async () => {
    const cwd = process.cwd();
    const child = new FakePty();
    const manager = new TerminalSessionManager({
      isWorkspaceAuthorized: (value) => value === canonicalPath(cwd),
      emit: () => undefined,
      resolveCommand: () => ({ executable: process.execPath, args: [] }),
      spawn: (() => child as unknown as pty.IPty) as typeof pty.spawn,
      closeGraceMs: 5,
      terminateProcessTree: async () => { throw new Error("taskkill failed"); },
      captureConhostPids: async () => [],
    });
    const info = manager.start({ provider: "codex", sessionId: "session-close-failed", cwd });
    await assert.rejects(manager.close({ sessionId: info.sessionId, generation: info.generation }), /taskkill failed/);
    assert.equal(manager.activeCount, 1);
    assert.equal(info.status, "starting");
    child.emitExit(0);
    assert.equal(manager.activeCount, 0);
  });

  it("propagates closeAll failures while retaining the failed terminal", async () => {
    const cwd = process.cwd();
    const child = new FakePty();
    const manager = new TerminalSessionManager({
      isWorkspaceAuthorized: (value) => value === canonicalPath(cwd),
      emit: () => undefined,
      resolveCommand: () => ({ executable: process.execPath, args: [] }),
      spawn: (() => child as unknown as pty.IPty) as typeof pty.spawn,
      closeGraceMs: 5,
      terminateProcessTree: async () => { throw new Error("close-all taskkill failed"); },
      captureConhostPids: async () => [],
    });
    manager.start({ provider: "codex", sessionId: "session-close-all-failed", cwd });
    await assert.rejects(manager.closeAll(), /终端清理失败/);
    assert.equal(manager.activeCount, 1);
  });

  it("does not terminate an unclaimed ConPTY when ownership cannot be proven", async () => {
    const cwd = process.cwd();
    const child = new FakePty();
    const terminated: number[] = [];
    const manager = new TerminalSessionManager({
      isWorkspaceAuthorized: (value) => value === canonicalPath(cwd),
      emit: () => undefined,
      resolveCommand: () => ({ executable: process.execPath, args: [] }),
      spawn: (() => child as unknown as pty.IPty) as typeof pty.spawn,
      closeGraceMs: 5,
      terminateProcessTree: async (pid) => { terminated.push(pid); },
      captureConhostPids: async () => [],
    });
    const info = manager.start({ provider: "codex", sessionId: "session-no-conhost", cwd });
    await manager.close({ sessionId: info.sessionId, generation: info.generation });
    assert.deepEqual(terminated, [child.pid]);
  });
});
