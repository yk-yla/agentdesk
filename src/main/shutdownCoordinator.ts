export interface ShutdownStep {
  name: string;
  run: () => Promise<unknown>;
}

export async function runShutdownSteps(steps: ShutdownStep[]) {
  const failures: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failures.push(`${step.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) throw new Error(`关闭后台服务失败：${failures.join("；")}`);
}

export class ShutdownCoordinator {
  private running: Promise<void> | null = null;

  constructor(private readonly timeoutMs = 15_000, private readonly timeoutMessage = "关闭后台服务超时，已取消退出。") {}

  run(task: () => Promise<void>) {
    if (!this.running) {
      this.running = Promise.resolve()
        .then(task)
        .finally(() => { this.running = null; });
    }
    const operation = this.running;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(() => finish(new Error(this.timeoutMessage)), this.timeoutMs);
      timer.unref?.();
      operation.then(() => finish(), finish);
    });
  }
}
