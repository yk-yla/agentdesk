import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CODEX_CAPABILITIES } from "./domain";
import { suggestionsFor } from "./commandSuggestions";

describe("command suggestions", () => {
  it("sorts recently used commands and skills first while keeping default order for ties", () => {
    const suggestions = suggestionsFor("/", [
      { name: "zulu", description: "Z", path: "z", scope: "user", enabled: true },
      { name: "alpha", description: "A", path: "a", scope: "user", enabled: true },
    ], CODEX_CAPABILITIES, { "skill:zulu": 20, "command:status": 30 });

    assert.deepEqual(suggestions.map((entry) => `${entry.kind}:${entry.name}`), [
      "command:status", "skill:zulu", "command:clear", "command:compact", "command:review", "command:mcp", "skill:alpha",
    ]);
  });
});
