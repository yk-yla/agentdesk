import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClaudeModelCache, sameClaudeModelCache, usableClaudeCachedModels } from "./claudeModelCache";

const model = { id: "sonnet", displayName: "Sonnet", description: "", efforts: ["medium"], defaultEffort: "medium", supportsImage: true };

describe("Claude model cache", () => {
  it("creates public metadata and reuses a compatible recent cache", () => {
    const cache = createClaudeModelCache([model], "1.2.3", 10_000);
    assert.deepEqual(usableClaudeCachedModels(cache, "1.2.3", 11_000).map((entry) => entry.id), ["sonnet"]);
    assert.equal(sameClaudeModelCache(cache, createClaudeModelCache([model], "1.2.3", 10_000)), true);
  });

  it("rejects unknown schema, expired cache and incompatible versions", () => {
    const cache = createClaudeModelCache([model], "1.2.3", 10_000)!;
    assert.deepEqual(usableClaudeCachedModels({ ...cache, schema: 2 }, "1.2.3", 11_000), []);
    assert.deepEqual(usableClaudeCachedModels(cache, "1.2.4", 10_000 + 14 * 24 * 60 * 60 * 1000 + 1), []);
    assert.deepEqual(usableClaudeCachedModels({ ...cache, claudeVersion: "unknown" }, undefined, 11_000), []);
  });
});
