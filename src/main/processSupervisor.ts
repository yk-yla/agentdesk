import { spawn, type ChildProcess } from "node:child_process";

export type ProcessTreeTerminator = (child: ChildProcess) => Promise<void>;

export function terminateWindowsProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 5_000);
    killer.once("error", finish);
    killer.once("exit", finish);
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
