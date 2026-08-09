import { spawn, type ChildProcess } from "node:child_process";

export interface TrackedClaudeProcess {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: "exit" | "error", listener: () => void): this;
  removeListener(event: "exit" | "error", listener: () => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

type TreeTerminator = (process: TrackedClaudeProcess) => Promise<void>;

function waitForExit(child: TrackedClaudeProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

export async function terminateClaudeProcessTree(child: TrackedClaudeProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await waitForExit(child, 750);
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32" && child.pid) {
      await new Promise<void>((resolve, reject) => {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, shell: false, stdio: "ignore" });
        const timer = setTimeout(() => reject(new Error(`Claude 进程树 ${child.pid} 终止超时。`)), 5_000);
        killer.once("error", (error) => { clearTimeout(timer); reject(error); });
        killer.once("exit", (code) => { clearTimeout(timer); code === 0 || child.exitCode !== null ? resolve() : reject(new Error(`Claude 进程树 ${child.pid} 终止失败（${code}）。`)); });
      });
    } else {
      child.kill("SIGKILL");
    }
  }
  if (!await waitForExit(child, 5_000)) throw new Error(`Claude 进程树 ${child.pid || "未知"} 未在时限内退出。`);
}

function queryKey(sessionId: string, generation: number) {
  return `${sessionId}\u0000${generation}`;
}

/** Tracks only roots spawned by this Worker, so one Query cannot terminate another Query's process. */
export class ClaudeProcessTreeController {
  private readonly roots = new Map<string, TrackedClaudeProcess>();
  private readonly closing = new Map<string, Promise<void>>();

  constructor(private readonly terminate: TreeTerminator = terminateClaudeProcessTree) {}

  track(sessionId: string, generation: number, child: ChildProcess | TrackedClaudeProcess) {
    const key = queryKey(sessionId, generation);
    if (this.roots.has(key)) throw new Error("Claude Query 已记录根进程。" );
    this.roots.set(key, child as TrackedClaudeProcess);
    return child.pid || null;
  }

  rootPid(sessionId: string, generation: number) {
    return this.roots.get(queryKey(sessionId, generation))?.pid || null;
  }

  close(sessionId: string, generation: number) {
    const key = queryKey(sessionId, generation);
    const existing = this.closing.get(key);
    if (existing) return existing;
    const child = this.roots.get(key);
    if (!child) return Promise.resolve();
    const promise = this.terminate(child).then(() => {
      if (this.roots.get(key) === child) this.roots.delete(key);
    }).finally(() => {
      this.closing.delete(key);
    });
    this.closing.set(key, promise);
    return promise;
  }

  async closeAll() {
    await Promise.all([...this.roots.keys()].map((key) => {
      const separator = key.lastIndexOf("\u0000");
      return this.close(key.slice(0, separator), Number(key.slice(separator + 1)));
    }));
  }
}
