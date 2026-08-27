import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldUseTerminalHistoryRequest } from "./terminalHistoryRequest";

const terminal = { presentationMode: "terminal" as const, threadId: "thread-1" };
const claude = { provider: "claude" as const, presentationMode: "workbench" as const, readOnly: true, threadId: "thread-1" };

describe("terminal history request routing", () => {
  it("uses the unscoped history path for terminal history operations", () => {
    for (const operation of ["readSession", "forkSession", "renameSession", "deleteSession", "updateSessionMetadata"] as const) {
      assert.equal(shouldUseTerminalHistoryRequest(terminal, operation), true, operation);
    }
  });

  it("keeps ordinary Agent requests scoped to workbench sessions", () => {
    assert.equal(shouldUseTerminalHistoryRequest({ ...terminal, presentationMode: "workbench" }, "renameSession"), false);
    assert.equal(shouldUseTerminalHistoryRequest({ ...terminal, threadId: null }, "renameSession"), false);
    assert.equal(shouldUseTerminalHistoryRequest(terminal, "startTurn"), false);
    assert.equal(shouldUseTerminalHistoryRequest(undefined, "renameSession"), false);
  });

  it("uses the unscoped history path for read-only external Claude sessions", () => {
    assert.equal(shouldUseTerminalHistoryRequest(claude, "readSession"), true);
    assert.equal(shouldUseTerminalHistoryRequest(claude, "renameSession"), true);
    assert.equal(shouldUseTerminalHistoryRequest({ ...claude, readOnly: false }, "readSession"), false);
    assert.equal(shouldUseTerminalHistoryRequest({ ...claude, provider: "codex" }, "readSession"), false);
  });
});
