import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { userFacingErrorMessage } from "./errorMessage";

describe("user-facing error messages", () => {
  it("removes Electron IPC implementation details", () => {
    assert.equal(
      userFacingErrorMessage(new Error("Error invoking remote method 'agentdesk:save-preferences': Error: 找不到 Windows Terminal。"), "保存失败。"),
      "找不到 Windows Terminal。",
    );
  });

  it("uses a readable fallback for an empty error", () => {
    assert.equal(userFacingErrorMessage({}, "保存失败。"), "保存失败。");
  });
});
