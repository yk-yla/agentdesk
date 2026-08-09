import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { ClaudeProcessTreeController, type TrackedClaudeProcess } from "./claudeProcessTree";

class FakeProcess extends EventEmitter implements TrackedClaudeProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly pid: number) { super(); }
  kill() { this.signalCode = "SIGKILL"; this.emit("exit"); return true; }
}

describe("Claude process tree controller", () => {
  it("isolates parallel queries and makes repeated close idempotent", async () => {
    const terminated: number[] = [];
    const controller = new ClaudeProcessTreeController(async (child) => { terminated.push(child.pid || 0); child.kill("SIGKILL"); });
    controller.track("a", 1, new FakeProcess(101));
    controller.track("b", 2, new FakeProcess(202));
    await Promise.all([controller.close("a", 1), controller.close("a", 1)]);
    assert.deepEqual(terminated, [101]);
    assert.equal(controller.rootPid("b", 2), 202);
    await controller.closeAll();
    assert.deepEqual(terminated, [101, 202]);
  });

  it("does not terminate an unknown generation and surfaces termination failures", async () => {
    const controller = new ClaudeProcessTreeController(async () => { throw new Error("fixture terminate failed"); });
    controller.track("a", 3, new FakeProcess(303));
    await controller.close("a", 2);
    assert.equal(controller.rootPid("a", 3), 303);
    await assert.rejects(controller.close("a", 3), /terminate failed/);
    assert.equal(controller.rootPid("a", 3), 303);
  });
});
