import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatMessageTimestamp, getMessageTimeDivider, timestampFromUnknown } from "./messageTimestamp";

describe("message timestamps", () => {
  it("formats the complete timestamp shown in the hover toolbar", () => {
    const sentAt = new Date(2026, 7, 12, 9, 5, 7).getTime();
    assert.equal(formatMessageTimestamp(sentAt), "2026-08-12 09:05:07");
  });

  it("uses date dividers for today, yesterday, and earlier dates", () => {
    const now = new Date(2026, 7, 12, 18, 0, 0).getTime();
    assert.deepEqual(getMessageTimeDivider(new Date(2026, 7, 12, 9).getTime(), undefined, now), { kind: "date", label: "今天" });
    assert.deepEqual(getMessageTimeDivider(new Date(2026, 7, 11, 23).getTime(), undefined, now), { kind: "date", label: "昨天" });
    assert.deepEqual(getMessageTimeDivider(new Date(2025, 11, 31, 23).getTime(), undefined, now), { kind: "date", label: "2025年12月31日" });
  });

  it("shows a time divider only when same-day messages are over ten minutes apart", () => {
    const previous = new Date(2026, 7, 12, 9, 5).getTime();
    assert.equal(getMessageTimeDivider(previous + 10 * 60 * 1000, previous), null);
    assert.deepEqual(getMessageTimeDivider(previous + 10 * 60 * 1000 + 1, previous), { kind: "time", label: "09:15" });
  });

  it("uses a date divider when messages cross midnight", () => {
    const now = new Date(2026, 7, 12, 18).getTime();
    const previous = new Date(2026, 7, 11, 23, 59).getTime();
    const current = new Date(2026, 7, 12, 0, 1).getTime();
    assert.deepEqual(getMessageTimeDivider(current, previous, now), { kind: "date", label: "今天" });
  });

  it("reads provider ISO timestamps and rejects malformed values", () => {
    assert.equal(timestampFromUnknown("2026-08-12T09:05:07.000Z"), Date.parse("2026-08-12T09:05:07.000Z"));
    assert.equal(timestampFromUnknown("not-a-date"), undefined);
  });
});
