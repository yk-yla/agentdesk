import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { ProcessSupervisor } from "./processSupervisor";

function fakeChild(pid: number) {
  return Object.assign(new EventEmitter(), {
    pid,
    killed: false,
    exitCode: null,
  }) as unknown as ChildProcess;
}

describe("ProcessSupervisor", () => {
  it("removes a tracked process after its natural exit", () => {
    const supervisor = new ProcessSupervisor(async () => undefined);
    const child = fakeChild(1);
    supervisor.track(child);
    assert.equal(supervisor.trackedCount, 1);
    child.emit("exit", 0, null);
    assert.equal(supervisor.trackedCount, 0);
  });

  it("terminates every tracked process once and clears the registry", async () => {
    const terminated: number[] = [];
    const supervisor = new ProcessSupervisor(async (child) => {
      terminated.push(child.pid || 0);
    });
    supervisor.track(fakeChild(10));
    supervisor.track(fakeChild(20));

    await supervisor.terminateAll();
    await supervisor.terminateAll();

    assert.deepEqual(terminated.sort((left, right) => left - right), [10, 20]);
    assert.equal(supervisor.trackedCount, 0);
  });

  it("clears failed processes so a later shutdown does not retry stale children", async () => {
    let attempts = 0;
    const supervisor = new ProcessSupervisor(async () => {
      attempts += 1;
      throw new Error("terminate failed");
    });
    supervisor.track(fakeChild(30));

    await assert.rejects(supervisor.terminateAll(), /terminate failed/);
    assert.equal(supervisor.trackedCount, 0);
    await supervisor.terminateAll();
    assert.equal(attempts, 1);
  });
});
