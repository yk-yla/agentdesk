import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerHistoricalWorkspace, restoreHistoricalSession } from "./historicalSessionRestore";

describe("restoreHistoricalSession", () => {
  it("registers a resumed session before reading its history", async () => {
    const order: string[] = [];
    let finishResume!: (value: string) => void;
    const resumePending = new Promise<string>((resolve) => { finishResume = resolve; });
    const restoring = restoreHistoricalSession({
      resume: async () => {
        order.push("resume");
        return resumePending;
      },
      applyResume: (value) => order.push(`apply:${value}`),
      read: async () => {
        order.push("read");
        return "history";
      },
      applyRead: (value) => order.push(`apply:${value}`),
    });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(order, ["resume"]);
    finishResume("registered");
    await restoring;
    assert.deepEqual(order, ["resume", "apply:registered", "read", "apply:history"]);
  });

  it("does not read history when session resume fails", async () => {
    let readCalled = false;
    await assert.rejects(restoreHistoricalSession({
      resume: async () => { throw new Error("resume failed"); },
      applyResume: () => undefined,
      read: async () => { readCalled = true; return "history"; },
      applyRead: () => undefined,
    }), /resume failed/);
    assert.equal(readCalled, false);
  });
});

describe("registerHistoricalWorkspace", () => {
  it("returns the main-process registered workspace", async () => {
    const calls: string[] = [];
    const registered = await registerHistoricalWorkspace(async (cwd) => {
      calls.push(cwd);
      return "D:\\canonical";
    }, "D:\\favorite");
    assert.equal(registered, "D:\\canonical");
    assert.deepEqual(calls, ["D:\\favorite"]);
  });

  it("rejects a workspace that was not registered", async () => {
    await assert.rejects(registerHistoricalWorkspace(async () => null, "D:\\missing"), /不存在或未获授权/);
  });
});
