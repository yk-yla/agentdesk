import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptySession } from "../domain";
import { createClaudeModelCache } from "./claudeModelCache";
import { initialProviderCapabilities, initialProviderModels, newSessionDefaults, normalizeAgentRequestError, providerHistoryParams } from "./providerRegistry";

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
    assert.equal(capabilities.claude.images, "supported");
    assert.equal(capabilities.claude.history, "supported");
    assert.equal(capabilities.claude.compact, "temporarilyUnavailable");
    assert.equal(capabilities.claude.pluginMarketplace, "supported");
    assert.equal(providerHistoryParams("codex", { cursor: null, limit: 100, cwd: "C:\\w" }).archived, false);
    assert.equal(providerHistoryParams("claude", { cursor: null, limit: 100, cwd: "C:\\w" }).archived, undefined);
  });

  it("normalizes provider errors without changing session ownership", () => {
    const session = emptySession("s", "C:\\w", "", "", "claude");
    assert.equal(session.provider, "claude");
    assert.equal(normalizeAgentRequestError("claude", "startTurn", new Error("failed")).message, "failed");
  });

  it("uses a compatible Claude cache and falls back for first install or upgrades", () => {
    const cachedModel = { id: "cached-sonnet", displayName: "Cached Sonnet", description: "", efforts: ["medium"], defaultEffort: "medium", supportsImage: true };
    const cache = createClaudeModelCache([cachedModel], "1.2.3")!;
    assert.deepEqual(initialProviderModels(cache, "1.2.3").claude.map((entry) => entry.id), ["cached-sonnet"]);
    assert.deepEqual(initialProviderModels(cache, "1.2.4").claude.map((entry) => entry.id), ["default", "opus[1m]", "sonnet", "sonnet[1m]", "haiku"]);
    assert.equal(initialProviderModels().claude[0]?.id, "default");
  });
});
