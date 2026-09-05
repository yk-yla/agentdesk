import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptySession } from "../domain";
import { createClaudeModelCache } from "./claudeModelCache";
import { initialProviderCapabilities, initialProviderModels, newSessionDefaults, normalizeAgentRequestError, providerHistoryParams, retargetEmptySession } from "./providerRegistry";

describe("renderer provider registry", () => {
  it("owns provider defaults and history parameters", () => {
    const capabilities = initialProviderCapabilities();
    const models = initialProviderModels();
    const model = { id: "codex-test", displayName: "Codex Test", description: "", efforts: ["medium"], defaultEffort: "medium", supportsImage: true };
    assert.equal(newSessionDefaults("codex", [model], { model: "codex-test", effort: "medium" }, capabilities.codex).model, "codex-test");
    assert.deepEqual(models.claude.map((entry) => entry.id), ["default", "opus[1m]", "sonnet", "sonnet[1m]", "haiku"]);
    assert.deepEqual(newSessionDefaults("claude", models.claude, { model: "codex-test", effort: "medium" }, capabilities.claude), {
      model: "default",
      effort: "medium",
      capabilities: capabilities.claude,
    });
    assert.equal(newSessionDefaults("claude", models.claude, { model: "", effort: "" }, capabilities.claude, "xhigh").effort, "xhigh");
    const configurableCodexModel = { ...model, efforts: ["medium", "high", "xhigh"] };
    assert.equal(newSessionDefaults("codex", [configurableCodexModel], { model: "codex-test", effort: "medium" }, capabilities.codex, "xhigh").effort, "xhigh");
    assert.equal(newSessionDefaults("codex", [configurableCodexModel], { model: "codex-test", effort: "medium" }, capabilities.codex, "max").effort, "medium");
    const alternateCodexModel = { id: "gpt-6-astra", displayName: "GPT-6-Astra", description: "", efforts: ["medium", "high"], defaultEffort: "medium", supportsImage: true };
    assert.deepEqual(newSessionDefaults("codex", [model, alternateCodexModel], { model: "codex-test", effort: "medium" }, capabilities.codex, "high", "gpt-6-astra"), {
      model: "gpt-6-astra",
      effort: "high",
      capabilities: capabilities.codex,
    });
    assert.equal(capabilities.claude.images, "supported");
    assert.equal(capabilities.claude.history, "supported");
    assert.equal(capabilities.claude.compact, "temporarilyUnavailable");
    assert.equal(providerHistoryParams("codex", { cursor: null, limit: 100, cwd: "C:\\w" }).archived, false);
    assert.equal(providerHistoryParams("claude", { cursor: null, limit: 100, cwd: "C:\\w" }).archived, undefined);
    assert.deepEqual(providerHistoryParams("claude", { cursor: null, limit: 50, allWorkspaces: true }), { cursor: null, limit: 50, allWorkspaces: true });
    assert.equal(providerHistoryParams("codex", { cursor: null, limit: 50, allWorkspaces: true }).allWorkspaces, true);
    assert.equal(providerHistoryParams("codex", { cursor: null, limit: 50, allWorkspaces: true }).cwd, undefined);
  });

  it("normalizes provider errors without changing session ownership", () => {
    const session = emptySession("s", "C:\\w", "", "", "claude");
    assert.equal(session.provider, "claude");
    assert.equal(normalizeAgentRequestError("claude", "startTurn", new Error("failed")).message, "failed");
  });

  it("rebuilds Provider-specific state when an empty tab opens another Provider's history", () => {
    const capabilities = initialProviderCapabilities();
    const models = initialProviderModels();
    const codex = emptySession("session", "C:\\workspace", "gpt-5.6-sol", "xhigh", "codex");
    codex.capabilities = capabilities.codex;
    codex.resolvedModel = "gpt-5.6-sol";
    codex.tokenUsage = { used: 12, total: 258_000 };

    const claude = retargetEmptySession(
      codex,
      "claude",
      "C:\\workspace",
      "claude-thread",
      "Claude history",
      models.claude,
      { model: "gpt-5.6-sol", effort: "xhigh" },
      capabilities.claude,
    );

    assert.equal(claude.provider, "claude");
    assert.equal(claude.model, "default");
    assert.equal(claude.effort, "medium");
    assert.equal(claude.resolvedModel, undefined);
    assert.deepEqual(claude.tokenUsage, { used: 0, total: null });
    assert.equal(claude.capabilities.review, "unsupported");
    assert.equal(claude.threadId, "claude-thread");
  });

  it("uses a compatible Claude cache and falls back for first install or upgrades", () => {
    const cachedModel = { id: "cached-sonnet", displayName: "Cached Sonnet", description: "", efforts: ["medium"], defaultEffort: "medium", supportsImage: true };
    const cache = createClaudeModelCache([cachedModel], "1.2.3")!;
    assert.deepEqual(initialProviderModels(cache, "1.2.3").claude.map((entry) => entry.id), ["cached-sonnet"]);
    assert.deepEqual(initialProviderModels(cache, "1.2.4").claude.map((entry) => entry.id), ["default", "opus[1m]", "sonnet", "sonnet[1m]", "haiku"]);
    assert.equal(initialProviderModels().claude[0]?.id, "default");
  });
});
