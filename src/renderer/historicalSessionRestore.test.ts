import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { restoreHistoricalSession } from "./historicalSessionRestore";

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
