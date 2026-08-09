import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptySession } from "./domain";
import { notificationActivationTarget } from "./notificationActivation";

describe("notification activation", () => {
  it("ignores a notification after its session has closed", () => {
    const sessions = { open: emptySession("open", "C:\\w") };
    assert.equal(notificationActivationTarget(sessions, "open"), "open");
    assert.equal(notificationActivationTarget(sessions, "closed"), null);
  });
});

