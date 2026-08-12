import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatMessageTimestamp, timestampFromUnknown } from "./messageTimestamp";

describe("message timestamps", () => {
  it("shows only the time for messages sent today", () => {
    const now = new Date(2026, 7, 12, 18, 0, 0).getTime();
    const sentAt = new Date(2026, 7, 12, 9, 5, 7).getTime();
    assert.equal(formatMessageTimestamp(sentAt, now), "09:05:07");
  });

  it("includes the date for earlier messages", () => {
    const now = new Date(2026, 7, 12, 18, 0, 0).getTime();
    const sentAt = new Date(2026, 7, 11, 23, 4, 5).getTime();
    assert.equal(formatMessageTimestamp(sentAt, now), "2026-08-11 23:04:05");
  });

  it("reads provider ISO timestamps and rejects malformed values", () => {
    assert.equal(timestampFromUnknown("2026-08-12T09:05:07.000Z"), Date.parse("2026-08-12T09:05:07.000Z"));
    assert.equal(timestampFromUnknown("not-a-date"), undefined);
  });
});
