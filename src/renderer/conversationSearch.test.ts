import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findConversationSearchMatches, normalizedConversationSearchTerm } from "./conversationSearch";

describe("conversation search", () => {
  it("normalizes surrounding whitespace and case", () => {
    assert.equal(normalizedConversationSearchTerm("  CoDeX  "), "codex");
  });

  it("returns every non-overlapping occurrence with its message location", () => {
    const matches = findConversationSearchMatches([
      { id: "first", text: "Codex and codex" },
      { id: "second", text: "no match" },
      { id: "third", text: "CODEX" },
    ], " codex ");
    assert.deepEqual(matches, [
      { messageId: "first", messageIndex: 0, occurrence: 0 },
      { messageId: "first", messageIndex: 0, occurrence: 1 },
      { messageId: "third", messageIndex: 2, occurrence: 0 },
    ]);
  });

  it("does not search an empty term", () => {
    assert.deepEqual(findConversationSearchMatches([{ id: "message", text: "内容" }], "   "), []);
  });
});
