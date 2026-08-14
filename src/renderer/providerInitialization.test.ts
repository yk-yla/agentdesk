import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentCapabilities, AgentProvider } from "../shared/agentProtocol";
import { EMPTY_AGENT_CAPABILITIES } from "./domain";
import { initializeProviders, providerCanRestore } from "./providerInitialization";

function capabilities(): AgentCapabilities {
  return { ...EMPTY_AGENT_CAPABILITIES };
}

async function run(failures: string[] = [], providers?: AgentProvider[]) {
  const applied: string[] = [];
  const errors: string[] = [];
  const states: Partial<Record<AgentProvider, string>> = {};
  await initializeProviders({
    loadCodexModels: async () => {
      if (failures.includes("codex:models")) throw new Error("models failed");
      return ["model"];
    },
    loadCapabilities: async (provider: AgentProvider) => {
      if (failures.includes(`${provider}:capabilities`)) throw new Error(`${provider} failed`);
      return capabilities();
    },
    isActive: () => true,
    applyCodexModels: () => applied.push("codex:models"),
    applyCapabilities: (provider) => applied.push(`${provider}:capabilities`),
    reportError: (provider, phase) => errors.push(`${provider}:${phase}`),
    setProviderState: (provider, value) => { states[provider] = value; },
  }, providers);
  return { applied, errors, states };
}

describe("initializeProviders", () => {
  it("allows Claude restore independently when Codex startup failed", () => {
    const states = { codex: "error", claude: "ready" } as const;
    assert.equal(providerCanRestore(states, "codex"), false);
    assert.equal(providerCanRestore(states, "claude"), true);
  });

  it("marks Codex ready when both Codex branches succeed", async () => {
    const result = await run();
    assert.deepEqual(result.states, { claude: "ready", codex: "ready" });
    assert.deepEqual(result.errors, []);
  });

  it("initializes Claude without loading any Codex model or capability", async () => {
    const result = await run([], ["claude"]);
    assert.deepEqual(result.applied, ["claude:capabilities"]);
    assert.deepEqual(result.states, { claude: "ready" });
  });

  it("keeps Codex ready when only Claude initialization fails", async () => {
    const result = await run(["claude:capabilities"]);
    assert.deepEqual(result.states, { claude: "error", codex: "ready" });
    assert.deepEqual(result.errors, ["claude:capabilities"]);
    assert.ok(result.applied.includes("codex:models"));
    assert.ok(result.applied.includes("codex:capabilities"));
  });

  it("marks only Codex startup as failed when its models fail", async () => {
    const result = await run(["codex:models"]);
    assert.deepEqual(result.states, { claude: "ready", codex: "error" });
    assert.deepEqual(result.errors, ["codex:models"]);
    assert.ok(result.applied.includes("claude:capabilities"));
  });

  it("marks only Codex startup as failed when its capabilities fail", async () => {
    const result = await run(["codex:capabilities"]);
    assert.deepEqual(result.states, { claude: "ready", codex: "error" });
    assert.deepEqual(result.errors, ["codex:capabilities"]);
    assert.ok(result.applied.includes("claude:capabilities"));
  });
});
