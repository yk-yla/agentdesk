import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptySession } from "./domain";
import { recoverProviderSessions } from "./providerRecovery";

describe("provider recovery", () => {
  it("only settles sessions owned by the exited provider", () => {
    const codex = emptySession("codex", "C:\\workspace", "", "medium", "codex");
    const claude = emptySession("claude", "C:\\workspace", "", "", "claude");
    codex.status = "working";
    claude.status = "working";
    claude.queryGeneration = 7;
    claude.messages = [{ id: "stream", role: "assistant", text: "partial", images: [], streaming: true }];
    const recovered = recoverProviderSessions({ codex, claude }, "claude");
    assert.strictEqual(recovered.codex, codex);
    assert.equal(recovered.codex.status, "working");
    assert.equal(recovered.claude.status, "error");
    assert.equal(recovered.claude.queryGeneration, 0);
    assert.equal(recovered.claude.messages[0].streaming, false);
    assert.match(recovered.claude.errorText, /Claude Code/);
  });
});
