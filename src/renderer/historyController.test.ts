import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentOperation, AgentProvider } from "../shared/agentProtocol";
import type { JsonObject } from "../shared/protocol";
import { historyThread, type HistoryThread } from "./domain";
import { applyLocalSessionMetadata, favoriteHistoryEntries, HistoryController, mergeHistory, sortHistoryByRecency } from "./historyController";

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
  let recentLoading = false;
  let recentCursor: string | null = null;
  let searchResults: HistoryThread[] | null = null;
  let searchLoading = false;
  let searchCursor: string | null = null;
  const controller = new HistoryController({
    mergeEntries: (incoming) => { entries = mergeHistory(entries, incoming); },
    setLoading: (value) => { loading = value; },
    setCursor: (value) => { cursor = value; },
    setRecentLoading: (value) => { recentLoading = value; },
    setRecentCursor: (value) => { recentCursor = value; },
    setSearchResults: (incoming, merge) => { searchResults = merge ? mergeHistory(searchResults || [], incoming || []) : incoming; },
    setSearchLoading: (value) => { searchLoading = value; },
    setSearchCursor: (value) => { searchCursor = value; },
  }, {
    request,
    getPreferences: () => ({ lastWorkspace: "", favoriteWorkspaces: [], theme: "github-light", sessionAliases: {}, favoriteSessions: [] }),
    isVisible: () => true,
  });
  return {
    controller,
    get entries() { return entries; },
    get loading() { return loading; },
    get cursor() { return cursor; },
    get recentLoading() { return recentLoading; },
    get recentCursor() { return recentCursor; },
    get searchResults() { return searchResults; },
    get searchLoading() { return searchLoading; },
    get searchCursor() { return searchCursor; },
  };
}

describe("history helpers", () => {
  it("keeps Provider identities separate and applies aliases and favorites", () => {
    const merged = mergeHistory([thread("same", "codex", 1)], [thread("same", "claude", 2), thread("same", "codex", 3)]);
    const decorated = applyLocalSessionMetadata(merged, {
      lastWorkspace: "", favoriteWorkspaces: [],
      theme: "github-light",
      sessionAliases: { "claude:same": "Claude alias" },
      favoriteSessions: ["codex:same"],
      pinnedSessions: ["claude:same"],
    });

    assert.equal(decorated.length, 2);
    assert.equal(decorated.find((entry) => entry.provider === "claude")?.title, "Claude alias");
    assert.equal(decorated.find((entry) => entry.provider === "codex")?.isFavorite, true);
    assert.equal(decorated.find((entry) => entry.provider === "claude")?.isPinned, true);
  });

  it("restores cross-directory favorites from saved summaries", () => {
    const favorites = favoriteHistoryEntries([thread("loaded", "codex", 2)], {
      lastWorkspace: "", favoriteWorkspaces: [],
      theme: "github-light",
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
  it("does not request history before the startup workspace is ready", async () => {
    let calls = 0;
    const harness = createHarness(async (provider) => {
      calls += 1;
      return listValue(`${provider}-thread`, provider);
    });

    harness.controller.loadInitial("正在连接工作区");
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls, 0);
    assert.equal(harness.loading, false);
    assert.equal(harness.cursor, null);
  });

  it("loads both Providers and publishes the combined continuation cursor", async () => {
    const harness = createHarness(async (provider) => listValue(`${provider}-thread`, provider, `${provider}-next`));

    harness.controller.loadInitial("D:\\work");
    await waitFor(() => !harness.loading);

    assert.deepEqual(harness.entries.map((entry) => entry.id).sort(), ["claude-thread", "codex-thread"]);
    assert.deepEqual(JSON.parse(harness.cursor || "{}"), { codex: "codex-next", claude: "claude-next" });
  });

  it("sorts the global recent view strictly by live recency", () => {
    const entries = [
      { ...thread("favorite", "codex", 3), isFavorite: true },
      thread("live", "claude", 1),
      thread("newest", "codex", 4),
    ];
    assert.deepEqual(sortHistoryByRecency(entries, { "claude:live": 5 }).map((entry) => entry.id), ["live", "newest", "favorite"]);
  });

  it("loads only Claude history for a Claude-only workspace state", async () => {
    const calls: AgentProvider[] = [];
    const harness = createHarness(async (provider) => {
      calls.push(provider);
      return listValue(`${provider}-thread`, provider);
    });

    harness.controller.loadInitial("D:\\work", ["claude"]);
    await waitFor(() => !harness.loading);

    assert.deepEqual(calls, ["claude"]);
    assert.deepEqual(harness.entries.map((entry) => entry.id), ["claude-thread"]);
  });

  it("keeps Claude history when Codex history fails", async () => {
    const calls: AgentProvider[] = [];
    const harness = createHarness(async (provider) => {
      calls.push(provider);
      if (provider === "codex") throw new Error("codex unavailable");
      return listValue("claude-thread", provider);
    });

    harness.controller.loadInitial("D:\\work");
    await waitFor(() => !harness.loading);

    assert.deepEqual(calls.sort(), ["claude", "codex"]);
    assert.deepEqual(harness.entries.map((entry) => entry.id), ["claude-thread"]);
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

  it("loads history again when switching back to a previously visited workspace", async () => {
    const calls: string[] = [];
    const harness = createHarness(async (provider, _operation, params) => {
      const cwd = String(params.cwd);
      calls.push(`${provider}:${cwd}`);
      return listValue(`${provider}-${cwd.endsWith("one") ? "one" : "two"}`, provider);
    });

    harness.controller.loadInitial("D:\\one");
    await waitFor(() => !harness.loading);
    harness.controller.loadInitial("D:\\two");
    await waitFor(() => !harness.loading);
    harness.controller.loadInitial("D:\\one");
    await waitFor(() => !harness.loading);

    assert.equal(calls.filter((call) => call.endsWith("D:\\one")).length, 4);
    assert.deepEqual(harness.entries.map((entry) => entry.id).sort(), ["claude-one", "claude-two", "codex-one", "codex-two"]);
  });

  it("coalesces concurrent history refreshes", async () => {
    const pending = deferred<unknown>();
    let calls = 0;
    let holdRefresh = false;
    const harness = createHarness(async (provider) => {
      calls += 1;
      if (holdRefresh && provider === "codex") return pending.promise;
      return listValue("claude", provider);
    });

    harness.controller.loadInitial("D:\\work");
    await waitFor(() => !harness.loading);
    calls = 0;
    holdRefresh = true;
    const first = harness.controller.refresh();
    const second = harness.controller.refresh();
    assert.equal(first, second);
    assert.equal(calls, 2);
    pending.resolve(listValue("codex", "codex"));
    await first;
    assert.equal(calls, 2);
  });

  it("loads and paginates recent sessions across all workspaces", async () => {
    const calls: Array<{ provider: AgentProvider; params: JsonObject }> = [];
    const harness = createHarness(async (provider, operation, params) => {
      assert.equal(operation, "listSessions");
      calls.push({ provider, params });
      const page = params.cursor ? "later" : "first";
      return listValue(`${provider}-${page}`, provider, params.cursor ? null : `${provider}-next`);
    });

    await harness.controller.loadRecent();
    assert.equal(harness.recentLoading, false);
    assert.deepEqual(JSON.parse(harness.recentCursor || "{}"), { codex: "codex-next", claude: "claude-next" });
    assert.ok(calls.every((call) => call.params.allWorkspaces === true && call.params.cwd === undefined && call.params.limit === 50));

    await harness.controller.loadMoreRecent();
    assert.equal(harness.recentCursor, null);
    assert.deepEqual(harness.entries.map((entry) => entry.id).sort(), ["claude-first", "claude-later", "codex-first", "codex-later"]);
  });

  it("keeps directory and all-workspace content search scopes explicit", async () => {
    const calls: Array<{ provider: AgentProvider; params: JsonObject }> = [];
    const harness = createHarness(async (provider, operation, params) => {
      if (operation !== "searchSessions") return listValue("unused", provider);
      calls.push({ provider, params });
      return searchValue(`${provider}-result`, provider);
    });

    harness.controller.loadInitial("D:\\work");
    await waitFor(() => !harness.loading);
    await harness.controller.search("local", "directory");
    assert.ok(calls.every((call) => call.params.cwd === "D:\\work" && call.params.allWorkspaces === undefined));

    calls.length = 0;
    await harness.controller.search("global", "allWorkspaces");
    assert.ok(calls.every((call) => call.params.cwd === undefined && call.params.allWorkspaces === true));
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

  it("keeps Claude search results when Codex search fails", async () => {
    const harness = createHarness(async (provider, operation) => {
      if (operation !== "searchSessions") return listValue("unused", provider);
      if (provider === "codex") throw new Error("codex unavailable");
      return searchValue("claude-result", provider);
    });

    await harness.controller.search("query");

    assert.equal(harness.searchLoading, false);
    assert.deepEqual(harness.searchResults?.map((entry) => entry.id), ["claude-result"]);
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
