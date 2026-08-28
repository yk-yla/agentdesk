import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { finishWorkspaceRestore, MAX_WORKSPACE_RESTORE_ATTEMPTS, workspaceRestoreRetry } from "./workspaceRestorePolicy";

describe("workspace restore retry policy", () => {
  it("allows two retries and then stops", () => {
    assert.deepEqual(workspaceRestoreRetry(0), { attempt: 1, delayMs: 750 });
    assert.deepEqual(workspaceRestoreRetry(1), { attempt: 2, delayMs: 1_500 });
    assert.deepEqual(workspaceRestoreRetry(2), { attempt: 3, delayMs: null });
    assert.equal(MAX_WORKSPACE_RESTORE_ATTEMPTS, 3);
  });

  it("removes completed or failed sessions from both restore queues", () => {
    const pending = new Set(["session-1", "session-2"]);
    const inFlight = new Set(["session-1"]);
    finishWorkspaceRestore(pending, inFlight, "session-1");
    assert.deepEqual([...pending], ["session-2"]);
    assert.deepEqual([...inFlight], []);
  });
});
