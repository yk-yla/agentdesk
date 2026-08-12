import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityIconName } from "./activityIconPresentation";

describe("activity icons", () => {
  it("uses a failure icon before the activity kind", () => {
    assert.equal(activityIconName("mcpToolCall", "failed"), "failed");
    assert.equal(activityIconName("commandExecution", "failed"), "failed");
    assert.equal(activityIconName("fileChange", "declined"), "failed");
  });

  it("keeps normal progress and completion icons", () => {
    assert.equal(activityIconName("mcpToolCall", "inProgress"), "loading");
    assert.equal(activityIconName("mcpToolCall", "completed"), "check");
    assert.equal(activityIconName("commandExecution", "completed"), "terminal");
  });
});
