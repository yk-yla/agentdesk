import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CODEX_CAPABILITIES } from "./domain";
import { resolveComposerInput, suggestionsFor } from "./commandSuggestions";

describe("command suggestions", () => {
  it("sorts recently used commands and skills first while keeping default order for ties", () => {
    const suggestions = suggestionsFor("/", [
      { name: "zulu", description: "Z", path: "z", scope: "user", enabled: true },
      { name: "alpha", description: "A", path: "a", scope: "user", enabled: true },
    ], CODEX_CAPABILITIES, { "skill:zulu": 20, "command:status": 30 });

    assert.deepEqual(suggestions.map((entry) => `${entry.kind}:${entry.name}`), [
      "command:status", "skill:zulu", "command:clear", "command:compact", "command:model", "command:rename", "command:plan", "command:review", "command:mcp", "skill:alpha",
    ]);
  });

  it("keeps arguments when resolving a built-in command", () => {
    assert.deepEqual(resolveComposerInput("/model claude-opus-4-6[1m]", [], CODEX_CAPABILITIES), {
      kind: "command",
      name: "model",
      args: "claude-opus-4-6[1m]",
    });
  });

  it("keeps a Provider-native command visible when the matching local feature is unavailable", () => {
    const capabilities = { ...CODEX_CAPABILITIES, plans: "unsupported" as const };
    const suggestions = suggestionsFor("/plan", [
      { name: "plan", description: "Claude 原生命令", path: "command:plan", scope: "user", enabled: true },
    ], capabilities);

    assert.deepEqual(suggestions.map((entry) => `${entry.kind}:${entry.name}`), ["skill:plan"]);
    assert.deepEqual(resolveComposerInput("/plan", [
      { name: "plan", description: "Claude 原生命令", path: "command:plan", scope: "user", enabled: true },
    ], capabilities), {
      kind: "skill",
      skill: { name: "plan", description: "Claude 原生命令", path: "command:plan", scope: "user", enabled: true },
      prompt: "",
    });
  });
});
