import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CoalescingAsyncTask, SingleFlight } from "./asyncOperation";

describe("SingleFlight", () => {
  it("shares one operation for concurrent callers", async () => {
    const runner = new SingleFlight<number>();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = runner.run(async () => { calls += 1; await gate; return 7; });
    const second = runner.run(async () => { calls += 1; return 9; });
    assert.equal(first, second);
    assert.equal(runner.active, true);
    release();
    assert.deepEqual(await Promise.all([first, second]), [7, 7]);
    await Promise.resolve();
    assert.equal(runner.active, false);
    assert.equal(calls, 1);
  });
});

describe("CoalescingAsyncTask", () => {
  it("runs another pass when requested during an active pass", async () => {
    const runner = new CoalescingAsyncTask();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = async () => { calls += 1; if (calls === 1) await gate; };
    const first = runner.request(task);
    const second = runner.request(task);
    assert.equal(first, second);
    release();
    await first;
    assert.equal(calls, 2);
  });
});
