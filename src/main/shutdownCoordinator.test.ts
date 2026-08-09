import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runShutdownSteps, ShutdownCoordinator } from "./shutdownCoordinator";

describe("ShutdownCoordinator", () => {
  it("runs every cleanup step and reports all failures", async () => {
    const calls: string[] = [];
    await assert.rejects(
      runShutdownSteps([
        { name: "Codex", run: async () => { calls.push("codex"); throw new Error("server failed"); } },
        { name: "Claude", run: async () => { calls.push("claude"); } },
        { name: "进程树", run: async () => { calls.push("tree"); throw new Error("tree failed"); } },
      ]),
      /Codex: server failed.*进程树: tree failed/,
    );
    assert.deepEqual(calls, ["codex", "claude", "tree"]);
  });

  it("shares a successful shutdown across repeated callers", async () => {
    let calls = 0;
    const coordinator = new ShutdownCoordinator(100);
    const task = async () => { calls += 1; };
    await Promise.all([coordinator.run(task), coordinator.run(task), coordinator.run(task)]);
    assert.equal(calls, 1);
  });

  it("reports a partial shutdown failure to every caller and allows a later retry", async () => {
    let calls = 0;
    const coordinator = new ShutdownCoordinator(100);
    const task = async () => { calls += 1; throw new Error("Claude Worker close failed"); };
    await assert.rejects(coordinator.run(task), /Claude Worker close failed/);
    await assert.rejects(coordinator.run(task), /Claude Worker close failed/);
    assert.equal(calls, 2);
  });

  it("times out callers without starting a duplicate task", async () => {
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = new ShutdownCoordinator(10, "关闭后台服务超时，已取消退出。");
    const task = async () => { calls += 1; await pending; };
    await assert.rejects(coordinator.run(task), /关闭后台服务超时/);
    await assert.rejects(coordinator.run(task), /关闭后台服务超时/);
    assert.equal(calls, 1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await coordinator.run(async () => { calls += 1; });
    assert.equal(calls, 2);
  });

  it("propagates task errors before the timeout", async () => {
    const coordinator = new ShutdownCoordinator(100, "timeout");
    await assert.rejects(coordinator.run(async () => { throw new Error("close failed"); }), /close failed/);
  });
});
