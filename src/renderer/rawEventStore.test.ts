import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendRawEvent, clearRawEvents, rawEventCount, rawEventSnapshot, rawEventStoreStats } from "./rawEventStore";

describe("raw event store budgets", () => {
  it("trims old events and leaves an observable marker", () => {
    const sessionId = "raw-budget-session";
    try {
      for (let index = 0; index < 20_001; index += 1) appendRawEvent(sessionId, "event", { index });
      const snapshot = rawEventSnapshot(sessionId);
      assert.ok(rawEventCount(sessionId) <= 20_000);
      assert.ok(snapshot.some((event) => event.label === "client/events-trimmed"));
      const latestPayload = snapshot.at(-1)?.payload;
      assert.ok(latestPayload && typeof latestPayload === "object" && "index" in latestPayload);
      assert.equal(latestPayload.index, 20_000);
    } finally {
      clearRawEvents(sessionId);
    }
    assert.equal(rawEventCount(sessionId), 0);
  });

  it("compacts a single oversized payload before retaining it", () => {
    const sessionId = "raw-large-payload-session";
    const before = rawEventStoreStats();
    try {
      appendRawEvent(sessionId, "large", { text: "x".repeat(1024 * 1024) });
      const payload = rawEventSnapshot(sessionId)[0]?.payload;

      assert.ok(payload && typeof payload === "object" && "truncated" in payload);
      assert.equal(payload.truncated, true);
      assert.equal(rawEventStoreStats().compactedEvents, before.compactedEvents + 1);
    } finally {
      clearRawEvents(sessionId);
    }
  });

  it("trims by estimated bytes before reaching the event count limit", () => {
    const sessionId = "raw-byte-budget-session";
    const chunk = "x".repeat(400_000);
    try {
      for (let index = 0; index < 25; index += 1) appendRawEvent(sessionId, "event", { index, chunk });
      const snapshot = rawEventSnapshot(sessionId);

      assert.ok(rawEventCount(sessionId) < 25);
      assert.ok(snapshot.some((event) => event.label === "client/events-trimmed"));
      assert.ok(rawEventStoreStats().estimatedBytes <= 16 * 1024 * 1024);
    } finally {
      clearRawEvents(sessionId);
    }
  });
});
