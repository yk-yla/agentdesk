import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchClaudeHistorySessions, searchSnippet, sessionSearchText, visibleSessionText } from "./claudeHistorySearch";

describe("Claude history full-text search", () => {
  it("extracts visible user and assistant text without unrelated tool fields", () => {
    const text = visibleSessionText([
      { message: { content: [{ type: "text", text: "first user" }] } },
      { content: [{ type: "text", text: "middle assistant" }] },
      { binary: "SECRET-BINARY", tool_input: "SECRET-TOOL" },
      { prompt: "last user" },
    ]);
    assert.match(text, /first user/);
    assert.match(text, /middle assistant/);
    assert.match(text, /last user/);
    assert.doesNotMatch(text, /SECRET/);
  });

  it("loads later pages and returns a case-insensitive matching snippet", async () => {
    const full = await sessionSearchText(
      { sessionId: "history-1", firstPrompt: "opening" },
      "C:\\workspace",
      async (_sessionId, options) => options.offset === 0
        ? Array.from({ length: 200 }, (_, index) => ({ content: index === 199 ? "MIDDLE VALUE" : `row-${index}` }))
        : [{ message: { content: [{ text: "late Unique Needle" }] } }],
    );
    assert.match(full, /MIDDLE VALUE/);
    assert.match(full, /late Unique Needle/);
    assert.match(searchSnippet(full, "unique needle"), /late Unique Needle/);
  });

  it("bounds extracted text and snippets", () => {
    assert.equal(visibleSessionText({ text: "x".repeat(100) }, 32).length, 32);
    assert.ok(searchSnippet("a".repeat(1_000), "missing").length <= 800);
  });

  it("searches a globally listed session without inventing a workspace", async () => {
    let options: { dir?: string; limit: number; offset: number } | undefined;
    await sessionSearchText({ sessionId: "global" }, undefined, async (_sessionId, value) => {
      options = value;
      return [];
    });
    assert.equal(options?.dir, undefined);
  });

  it("searches sessions with bounded concurrency and preserves source order", async () => {
    let active = 0;
    let peak = 0;
    const result = await searchClaudeHistorySessions(
      ["one", "two", "three", "four"].map((sessionId) => ({ sessionId, firstPrompt: sessionId === "three" ? "needle" : "other" })),
      undefined,
      "needle",
      10,
      async (sessionId) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, sessionId === "one" ? 5 : 1));
        active -= 1;
        return [];
      },
      2,
    );
    assert.ok(peak <= 2);
    assert.deepEqual(result.map((entry) => entry.session.sessionId), ["three"]);
  });
});
