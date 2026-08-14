import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { automaticClaudeToolPermission, settingsWithoutClaudePermissionRules } from "./claudePermissionPolicy";

describe("Claude permission policy", () => {
  it("automatically allows normal tools without a permission interaction", () => {
    assert.deepEqual(automaticClaudeToolPermission("Bash", { command: "git status" }), {
      behavior: "allow",
      updatedInput: { command: "git status" },
    });
  });

  it("keeps AskUserQuestion as a real user interaction", () => {
    assert.equal(automaticClaudeToolPermission("AskUserQuestion", { questions: [] }), null);
  });

  it("removes inherited allow, ask and deny rules from a Query snapshot", () => {
    const settings = settingsWithoutClaudePermissionRules({
      permissions: { allow: ["Read"], ask: ["Bash"], deny: ["Write"] },
      includeGitInstructions: false,
    });
    assert.equal("permissions" in settings, false);
    assert.equal(settings.includeGitInstructions, false);
  });
});
