import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activitiesForMainConversation } from "./activityPresentation";
import type { Activity } from "./domain";

function activity(status: Activity["status"], visibleInMain = true): Activity {
  return { id: status, kind: "mcpToolCall", title: "工具调用", detail: "docs / fetch", status, visibleInMain };
}

describe("main conversation activities", () => {
  it("hides successful and running tool records in simple mode", () => {
    assert.deepEqual(activitiesForMainConversation([
      activity("inProgress"),
      activity("completed"),
      activity("failed"),
    ]).map((entry) => entry.status), ["failed"]);
  });

  it("keeps only visible failures, declines and interruptions", () => {
    assert.deepEqual(activitiesForMainConversation([
      activity("failed", false),
      activity("failed"),
      activity("declined"),
      activity("interrupted"),
    ]).map((entry) => entry.status), ["failed", "declined", "interrupted"]);
  });
});
