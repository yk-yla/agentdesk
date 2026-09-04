import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventLoopLagTracker } from "./rendererDiagnostics";

describe("EventLoopLagTracker", () => {
  it("ignores hidden timer throttling and measures later visible stalls", () => {
    let now = 0;
    const tracker = new EventLoopLagTracker(1_000, () => now);

    now = 60_000;
    assert.equal(tracker.sample(false), null);
    now = 61_050;
    assert.equal(tracker.sample(true), 50);
    now = 62_500;
    assert.equal(tracker.sample(true), 450);
  });

  it("resets the expected tick when a window becomes visible again", () => {
    let now = 0;
    const tracker = new EventLoopLagTracker(1_000, () => now);

    now = 55_000;
    tracker.reset();
    now = 56_030;

    assert.equal(tracker.sample(true), 30);
  });
});
