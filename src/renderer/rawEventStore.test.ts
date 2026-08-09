import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendRawEvent, clearRawEvents, rawEventCount, rawEventSnapshot } from "./rawEventStore";

describe("raw event store budgets", () => {
  it("trims old events and leaves an observable marker", () => {
    const sessionId = "raw-budget-session";
    try {
      for (let index = 0; index < 20_001; index += 1) appendRawEvent(sessionId, "event", { index });
      const snapshot = rawEventSnapshot(sessionId);
      assert.ok(rawEventCount(sessionId) <= 20_000);
      assert.ok(snapshot.some((event) => event.label === "client/events-trimmed"));
      assert.equal(snapshot.at(-1)?.payload && (snapshot.at(-1)?.payload as { index?: number }).index, 20_000);
    } finally {
      clearRawEvents(sessionId);
    }
    assert.equal(rawEventCount(sessionId), 0);
  });
});
