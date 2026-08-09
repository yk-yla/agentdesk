import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { favoriteSessionKey, normalizeFavoriteSessionSummaries } from "../shared/favoriteSessions";

describe("favorite session summaries", () => {
  it("normalizes valid summaries to provider-scoped keys", () => {
    assert.deepEqual(normalizeFavoriteSessionSummaries({
      legacy: { provider: "claude", id: "session-1", title: "  收藏会话  ", cwd: " D:\\work ", updatedAt: 123 },
    }), {
      [favoriteSessionKey("claude", "session-1")]: { provider: "claude", id: "session-1", title: "收藏会话", cwd: "D:\\work", updatedAt: 123 },
    });
  });

  it("drops malformed summaries", () => {
    assert.deepEqual(normalizeFavoriteSessionSummaries({
      missingDirectory: { provider: "codex", id: "session-1", title: "标题", cwd: "", updatedAt: 1 },
      badProvider: { provider: "other", id: "session-2", title: "标题", cwd: "D:\\work", updatedAt: 1 },
    }), {});
  });
});
