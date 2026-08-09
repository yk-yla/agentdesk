import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizedDirectory, type HistoryThread } from "./domain";
import { filterSidebarHistory, reorderFavoriteWorkspaceList } from "./sidebarViewModel";

function history(id: string, provider: "codex" | "claude", title: string): HistoryThread {
  return {
    id,
    provider,
    title,
    cwd: "D:\\workspace",
    cwdKey: normalizedDirectory("D:\\workspace"),
    titleLower: title.toLowerCase(),
    updatedAt: 1,
    source: provider,
    isPinned: false,
    isFavorite: false,
  };
}

describe("sidebar view model", () => {
  it("filters titles and providers without changing content-search results", () => {
    const entries = [history("1", "codex", "Release notes"), history("2", "claude", "Architecture")];
    assert.deepEqual(filterSidebarHistory({ entries, provider: "codex", query: "release", applyTitleFilter: true }).map((entry) => entry.id), ["1"]);
    assert.deepEqual(filterSidebarHistory({ entries, provider: "all", query: "missing", applyTitleFilter: false }).map((entry) => entry.id), ["1", "2"]);
  });

  it("reorders favorite workspaces without mutating the source", () => {
    const source = ["D:\\one", "D:\\two", "D:\\three"];
    const reordered = reorderFavoriteWorkspaceList(source, "d:\\three", "D:\\one");
    assert.deepEqual(reordered, ["D:\\three", "D:\\one", "D:\\two"]);
    assert.deepEqual(source, ["D:\\one", "D:\\two", "D:\\three"]);
    assert.equal(reorderFavoriteWorkspaceList(source, "D:\\missing", "D:\\one"), source);
  });
});
