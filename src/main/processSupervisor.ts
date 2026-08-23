import { spawn, type ChildProcess } from "node:child_process";

export type ProcessTreeTerminator = (child: ChildProcess) => Promise<void>;

export function terminateWindowsProcessTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`终止 Windows 进程 ${pid} 超时。`)), 5_000);
    killer.once("error", (error) => finish(error instanceof Error ? error : new Error(`无法启动 taskkill 终止进程 ${pid}。`)));
    killer.once("exit", (code, signal) => {
      // taskkill returns 128 when the process has already exited. The desired
      // end state is still satisfied in that case, so it is safe to continue.
      if (code === 0 || code === 128) finish();
      else finish(new Error(`taskkill 未能终止 Windows 进程 ${pid}（退出码 ${code ?? "未知"}${signal ? `，信号 ${signal}` : ""}）。`));
    });
  });
}

export function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.killed || child.exitCode !== null) return Promise.resolve();
  if (process.platform === "win32") return terminateWindowsProcessTree(child.pid);
  child.kill("SIGKILL");
  return Promise.resolve();
}

export class ProcessSupervisor {
  private readonly children = new Set<ChildProcess>();

  constructor(private readonly terminateTree: ProcessTreeTerminator = terminateProcessTree) {}

  track<T extends ChildProcess>(child: T): T {
    this.children.add(child);
    const remove = () => this.children.delete(child);
    child.once("error", remove);
    child.once("exit", remove);
    return child;
  }

  terminate(child: ChildProcess) {
    return this.terminateTree(child);
  }

  async terminateAll() {
    const children = [...this.children];
    await Promise.all(children.map(async (child) => {
      try {
        await this.terminateTree(child);
      } finally {
        this.children.delete(child);
      }
    }));
  }

  get trackedCount() {
    return this.children.size;
  }
}
