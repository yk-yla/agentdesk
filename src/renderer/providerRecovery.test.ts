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
    claude.plan = { explanation: "恢复测试", steps: [{ step: "当前步骤", status: "inProgress" }, { step: "后续步骤", status: "pending" }], updatedAt: 1 };
    const recovered = recoverProviderSessions({ codex, claude }, "claude");
    assert.strictEqual(recovered.codex, codex);
    assert.equal(recovered.codex.status, "working");
    assert.equal(recovered.claude.status, "error");
    assert.equal(recovered.claude.queryGeneration, 0);
    assert.equal(recovered.claude.messages[0].streaming, false);
    assert.deepEqual(recovered.claude.plan?.steps.map((step) => step.status), ["pending", "pending"]);
    assert.match(recovered.claude.errorText, /Claude Code/);
  });

  it("only settles the Codex page whose isolated service exited", () => {
    const first = emptySession("first", "C:\\workspace", "", "medium", "codex");
    const second = emptySession("second", "C:\\workspace", "", "medium", "codex");
    first.status = "working";
    second.status = "working";

    const recovered = recoverProviderSessions({ first, second }, "codex", new Set(["first"]));

    assert.equal(recovered.first.status, "error");
    assert.strictEqual(recovered.second, second);
    assert.equal(recovered.second.status, "working");
  });
});
