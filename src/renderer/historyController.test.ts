import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentOperation, AgentProvider } from "../shared/agentProtocol";
import type { JsonObject } from "../shared/protocol";
import { historyThread, type HistoryThread } from "./domain";
import { applyLocalSessionMetadata, favoriteHistoryEntries, HistoryController, mergeHistory } from "./historyController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("历史状态未在预期时间内收敛");
}

function thread(id: string, provider: AgentProvider = "codex", updatedAt = 1): HistoryThread {
  return historyThread({ id, provider, title: id, cwd: "D:\\work", updatedAt, source: "test" });
}

function listValue(id: string, provider: AgentProvider, nextCursor: string | null = null) {
  return { data: [{ id, provider, name: id, cwd: "D:\\work", updatedAt: 1 }], nextCursor };
}

function searchValue(id: string, provider: AgentProvider, nextCursor: string | null = null) {
  return { data: [{ thread: { id, provider, name: id, cwd: "D:\\work", updatedAt: 1 }, snippet: id }], nextCursor };
}

function createHarness(request: (provider: AgentProvider, operation: AgentOperation, params: JsonObject) => Promise<unknown>) {
  let entries: HistoryThread[] = [];
  let loading = false;
  let cursor: string | null = null;
  let searchResults: HistoryThread[] | null = null;
  let searchLoading = false;
  let searchCursor: string | null = null;
  const controller = new HistoryController({
    mergeEntries: (incoming) => { entries = mergeHistory(entries, incoming); },
    setLoading: (value) => { loading = value; },
    setCursor: (value) => { cursor = value; },
    setSearchResults: (incoming, merge) => { searchResults = merge ? mergeHistory(searchResults || [], incoming || []) : incoming; },
    setSearchLoading: (value) => { searchLoading = value; },
    setSearchCursor: (value) => { searchCursor = value; },
  }, {
    request,
    getPreferences: () => ({ recentWorkspaces: [], lastWorkspace: "", favoriteWorkspaces: [], theme: "system", displayMode: "simple", bossKey: "", sessionAliases: {}, favoriteSessions: [] }),
    isVisible: () => true,
  });
  return {
    controller,
    get entries() { return entries; },
    get loading() { return loading; },
    get cursor() { return cursor; },
    get searchResults() { return searchResults; },
    get searchLoading() { return searchLoading; },
    get searchCursor() { return searchCursor; },
  };
}

describe("history helpers", () => {
  it("keeps Provider identities separate and applies aliases and favorites", () => {
    const merged = mergeHistory([thread("same", "codex", 1)], [thread("same", "claude", 2), thread("same", "codex", 3)]);
    const decorated = applyLocalSessionMetadata(merged, {
      recentWorkspaces: [], lastWorkspace: "", favoriteWorkspaces: [],
      theme: "system", displayMode: "simple", bossKey: "",
      sessionAliases: { "claude:same": "Claude alias" },
      favoriteSessions: ["codex:same"],
    });

    assert.equal(decorated.length, 2);
    assert.equal(decorated.find((entry) => entry.provider === "claude")?.title, "Claude alias");
    assert.equal(decorated.find((entry) => entry.provider === "codex")?.isFavorite, true);
  });

  it("restores cross-directory favorites from saved summaries", () => {
    const favorites = favoriteHistoryEntries([thread("loaded", "codex", 2)], {
      recentWorkspaces: [], lastWorkspace: "", favoriteWorkspaces: [],
      theme: "system", displayMode: "simple", bossKey: "",
      favoriteSessions: ["codex:loaded", "claude:saved"],
      favoriteSessionSummaries: {
        "claude:saved": { provider: "claude", id: "saved", title: "跨目录收藏", cwd: "D:\\other", updatedAt: 3 },
      },
    });

    assert.deepEqual(favorites.map((entry) => `${entry.provider}:${entry.id}`), ["claude:saved", "codex:loaded"]);
    assert.equal(favorites[0]?.cwd, "D:\\other");
    assert.equal(favorites[0]?.isFavorite, true);
  });
});

describe("HistoryController", () => {
  it("loads both Providers and publishes the combined continuation cursor", async () => {
    const harness = createHarness(async (provider) => listValue(`${provider}-thread`, provider, `${provider}-next`));

    harness.controller.loadInitial("D:\\work");
    await waitFor(() => !harness.loading);

    assert.deepEqual(harness.entries.map((entry) => entry.id).sort(), ["claude-thread", "codex-thread"]);
    assert.deepEqual(JSON.parse(harness.cursor || "{}"), { codex: "codex-next", claude: "claude-next" });
  });

  it("ignores pages that finish after the workspace changes", async () => {
    const oldRequest = deferred<unknown>();
    const harness = createHarness(async (provider, _operation, params) => {
      if (params.cwd === "D:\\old") return oldRequest.promise;
      return listValue(`${provider}-new`, provider);
    });

    harness.controller.loadInitial("D:\\old");
    harness.controller.loadInitial("D:\\new");
    await waitFor(() => !harness.loading);
    oldRequest.resolve(listValue("old", "codex"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(harness.entries.map((entry) => entry.id).sort(), ["claude-new", "codex-new"]);
  });

  it("lets the latest search win when responses arrive out of order", async () => {
    const first = deferred<unknown>();
    const harness = createHarness(async (provider, operation, params) => {
      if (operation !== "searchSessions") return listValue("unused", provider);
      if (params.searchTerm === "first") return first.promise;
      return searchValue(`${provider}-second`, provider);
    });

    void harness.controller.search("first");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.controller.search("second");
    first.resolve(searchValue("codex-first", "codex"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(harness.searchLoading, false);
    assert.deepEqual(harness.searchResults?.map((entry) => entry.id).sort(), ["claude-second", "codex-second"]);
  });

  it("merges later search pages without duplicating an existing thread", async () => {
    const calls = new Map<AgentProvider, number>();
    const harness = createHarness(async (provider) => {
      const call = (calls.get(provider) || 0) + 1;
      calls.set(provider, call);
      return call === 1
        ? searchValue("shared", provider, `${provider}-next`)
        : searchValue(provider === "codex" ? "shared" : "claude-later", provider);
    });

    await harness.controller.search("query");
    await harness.controller.loadMoreSearch();

    assert.deepEqual(harness.searchResults?.map((entry) => `${entry.provider}:${entry.id}`).sort(), ["claude:claude-later", "claude:shared", "codex:shared"]);
    assert.equal(harness.searchCursor, null);
  });
});
