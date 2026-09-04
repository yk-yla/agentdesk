import type { AgentOperation, AgentProvider } from "../shared/agentProtocol";
import type { DesktopPreferences, FavoriteSessionSummary, JsonObject, LogLevel } from "../shared/protocol";
import { asRecord, historyThread, threadFromList, threadFromSearch, type HistoryThread } from "./domain";
import { providerHistoryParams } from "./agent/providerRegistry";

export function mergeHistory(current: HistoryThread[], incoming: HistoryThread[]) {
  const byId = new Map(current.map((entry) => [`${entry.provider}:${entry.id}`, entry]));
  for (const entry of incoming) {
    const key = `${entry.provider}:${entry.id}`;
    const existing = byId.get(key);
    if (!existing || entry.updatedAt > existing.updatedAt) byId.set(key, entry);
  }
  return sortHistory([...byId.values()]);
}

export function sortHistory(entries: HistoryThread[]) {
  return [...entries].sort((left, right) => Number(right.isFavorite) - Number(left.isFavorite) || Number(right.isPinned) - Number(left.isPinned) || right.updatedAt - left.updatedAt);
}

export function sortHistoryByRecency(entries: HistoryThread[], liveActivity: Record<string, number> = {}) {
  return [...entries].sort((left, right) => (
    Math.max(right.updatedAt, liveActivity[`${right.provider}:${right.id}`] || 0)
    - Math.max(left.updatedAt, liveActivity[`${left.provider}:${left.id}`] || 0)
  ));
}

export function applyLocalSessionMetadata(entries: HistoryThread[], preferences: DesktopPreferences) {
  const aliases = preferences.sessionAliases || {};
  const pinned = new Set(preferences.pinnedSessions || []);
  const favorites = new Set(preferences.favoriteSessions || []);
  return entries.map((entry) => {
    const key = `${entry.provider}:${entry.id}`;
    const title = aliases[key]?.trim() || aliases[entry.id]?.trim() || entry.title;
    return {
      ...entry,
      title,
      titleLower: title.toLowerCase(),
      isPinned: pinned.has(key) || pinned.has(entry.id),
      isFavorite: favorites.has(key) || favorites.has(entry.id),
    };
  });
}

export function isFavoriteSession(preferences: DesktopPreferences, provider: AgentProvider, id: string) {
  const favorites = preferences.favoriteSessions || [];
  return favorites.includes(`${provider}:${id}`) || favorites.includes(id);
}

export function favoriteSessionSummary(entry: { provider: AgentProvider; id: string; title: string; cwd: string; updatedAt: number; codexHome?: "agentdesk" | "default" }): FavoriteSessionSummary {
  return { provider: entry.provider, id: entry.id, title: entry.title || "无标题会话", cwd: entry.cwd, updatedAt: entry.updatedAt, ...(entry.provider === "codex" && entry.codexHome ? { codexHome: entry.codexHome } : {}) };
}

export function favoriteHistoryEntries(history: HistoryThread[], preferences: DesktopPreferences) {
  const entries = new Map<string, HistoryThread>();
  for (const entry of history) {
    if (!isFavoriteSession(preferences, entry.provider, entry.id)) continue;
    entries.set(`${entry.provider}:${entry.id}`, { ...entry, isFavorite: true });
  }
  for (const summary of Object.values(preferences.favoriteSessionSummaries || {})) {
    if (!isFavoriteSession(preferences, summary.provider, summary.id)) continue;
    const key = `${summary.provider}:${summary.id}`;
    if (entries.has(key)) continue;
    entries.set(key, historyThread({ ...summary, source: "favorite", isFavorite: true }));
  }
  return [...entries.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

interface HistoryCursor {
  codex: string | null;
  claude: string | null;
}

export type HistorySearchScope = "directory" | "allWorkspaces";

interface HistoryRequestScope {
  cwd?: string;
  allWorkspaces?: true;
}
interface HistoryBatch {
  cursor: string | null;
  entries: HistoryThread[];
}

interface CachedHistoryBatch extends HistoryBatch {
  loadedAt: number;
}

const INITIAL_HISTORY_CACHE_TTL_MS = 2 * 60_000;
const MAX_INITIAL_HISTORY_CACHE_ENTRIES = 64;


function decodeHistoryCursor(value: string | null): HistoryCursor {
  if (!value) return { codex: null, claude: null };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return { codex: typeof parsed.codex === "string" ? parsed.codex : null, claude: typeof parsed.claude === "string" ? parsed.claude : null };
  } catch {
    return { codex: value, claude: null };
  }
}

function encodeHistoryCursor(value: HistoryCursor) {
  return value.codex || value.claude ? JSON.stringify(value) : null;
}

export interface HistoryControllerState {
  mergeEntries(entries: HistoryThread[]): void;
  setLoading(loading: boolean): void;
  setCursor(cursor: string | null): void;
  setRecentLoading(loading: boolean): void;
  setRecentCursor(cursor: string | null): void;
  setSearchResults(entries: HistoryThread[] | null, merge: boolean): void;
  setSearchLoading(loading: boolean): void;
  setSearchCursor(cursor: string | null): void;
}

export interface HistoryControllerServices {
  request(provider: AgentProvider, operation: AgentOperation, params: JsonObject): Promise<unknown>;
  getPreferences(): DesktopPreferences;
  isVisible(): boolean;
  log?(level: LogLevel, event: string, details?: JsonObject): void;
}

export class HistoryController {
  private workspace = "";
  private historyCursor: string | null = null;
  private historyLoading = false;
  private recentCursor: string | null = null;
  private recentLoading = false;
  private recentLoaded = false;
  private searchTerm = "";
  private searchCursor: string | null = null;
  private searchLoading = false;
  private searchScope: HistorySearchScope = "directory";
  private historyGeneration = 0;
  private recentGeneration = 0;
  private searchGeneration = 0;
  private refreshPromise: Promise<void> | null = null;
  private lastRefreshAt = 0;
  private enabledProviders = new Set<AgentProvider>(["codex", "claude"]);
  private readonly initialHistoryCache = new Map<string, CachedHistoryBatch>();
  private readonly initialHistoryLoads = new Map<string, Promise<HistoryBatch>>();


  constructor(
    private readonly state: HistoryControllerState,
    private readonly services: HistoryControllerServices,
  ) {}
  private initialHistoryCacheKey(workspace: string, providers: ReadonlySet<AgentProvider> = this.enabledProviders) {
    return `${workspace.trim().toLocaleLowerCase()}\n${[...providers].sort().join(",")}`;
  }

  private rememberInitialHistory(key: string, batch: HistoryBatch) {
    this.initialHistoryCache.delete(key);
    this.initialHistoryCache.set(key, { ...batch, loadedAt: Date.now() });
    while (this.initialHistoryCache.size > MAX_INITIAL_HISTORY_CACHE_ENTRIES) {
      const oldest = this.initialHistoryCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.initialHistoryCache.delete(oldest);
    }
  }
  private mergeInitialHistory(key: string, batch: HistoryBatch, preserveCursor = false) {
    const existing = this.initialHistoryCache.get(key);
    this.rememberInitialHistory(key, {
      cursor: preserveCursor ? existing?.cursor ?? batch.cursor : batch.cursor,
      entries: mergeHistory(existing?.entries || [], batch.entries),
    });
  }



  private publishEntries(entries: HistoryThread[]) {
    if (entries.length) this.state.mergeEntries(applyLocalSessionMetadata(entries, this.services.getPreferences()));
  }

  private logProviderFailure(provider: AgentProvider, operation: "listSessions" | "searchSessions", error: unknown) {
    this.services.log?.("warn", "renderer.history_provider.failed", {
      provider,
      operation,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) },
    });
  }

  private async fetchProvider(provider: AgentProvider, cursor: string | null, maxPages: number, limit: number, scope: HistoryRequestScope) {
    let nextCursor = cursor;
    const entries: HistoryThread[] = [];
    for (let page = 0; page < maxPages; page += 1) {
      const value = await this.services.request(provider, "listSessions", providerHistoryParams(provider, {
        cursor: nextCursor,
        limit,
        ...scope,
      }));
      entries.push(...threadFromList(value));
      const next = asRecord(value).nextCursor;
      nextCursor = typeof next === "string" && next ? next : null;
      if (!nextCursor) break;
    }
    return { cursor: nextCursor, entries };
  }

  private async fetchMerged(
    cursor: string | null,
    maxPages: number,
    limit: number,
    scope: HistoryRequestScope,
    enabledProviders: ReadonlySet<AgentProvider> = this.enabledProviders,
  ): Promise<HistoryBatch> {
    const decoded = decodeHistoryCursor(cursor);
    const next = { ...decoded };
    const providers = (["codex", "claude"] as const).filter((provider) => enabledProviders.has(provider) && (cursor === null || decoded[provider] !== null));
    const results = await Promise.allSettled(providers.map((provider) => this.fetchProvider(provider, decoded[provider], maxPages, limit, scope)));
    const entries: HistoryThread[] = [];
    let firstError: unknown;
    let successCount = 0;
    for (const [index, result] of results.entries()) {
      const provider = providers[index];
      if (result.status === "fulfilled") {
        next[provider] = result.value.cursor;
        entries.push(...result.value.entries);
        successCount += 1;
      } else {
        firstError ??= result.reason;
        this.logProviderFailure(provider, "listSessions", result.reason);
      }
    }
    if (!successCount && firstError !== undefined) throw firstError;
    return { cursor: encodeHistoryCursor(next), entries };
  }


  loadInitial(workspace: string, providers: AgentProvider[] = ["codex", "claude"]) {
    const enabledProviders = new Set(providers);
    this.enabledProviders = enabledProviders;
    if (!workspace.trim() || workspace === "正在连接工作区" || workspace === "工作区不可用") {
      this.workspace = "";
      this.historyCursor = null;
      this.state.setCursor(null);
      this.historyLoading = false;
      this.state.setLoading(false);
      return () => undefined;
    }
    this.workspace = workspace;
    const cacheKey = this.initialHistoryCacheKey(workspace, enabledProviders);
    const cached = this.initialHistoryCache.get(cacheKey);
    const generation = ++this.historyGeneration;
    this.historyCursor = cached?.cursor || null;
    this.state.setCursor(this.historyCursor);
    if (cached) this.publishEntries(cached.entries);
    if (cached && Date.now() - cached.loadedAt <= INITIAL_HISTORY_CACHE_TTL_MS) {
      this.historyLoading = false;
      this.state.setLoading(false);
      this.services.log?.("info", "renderer.history_load.cache_hit", { workspace, entries: cached.entries.length });
      return () => {
        if (this.historyGeneration === generation) this.historyGeneration += 1;
      };
    }

    this.services.log?.("info", "renderer.history_load.started", { workspace, cached: Boolean(cached) });
    this.historyLoading = true;
    this.state.setLoading(true);
    let load = this.initialHistoryLoads.get(cacheKey);
    if (!load) {
      load = this.fetchMerged(null, 5, 100, { cwd: workspace }, enabledProviders)
        .then((batch) => {
          this.rememberInitialHistory(cacheKey, batch);
          return batch;
        })
        .finally(() => {
          if (this.initialHistoryLoads.get(cacheKey) === load) this.initialHistoryLoads.delete(cacheKey);
        });
      this.initialHistoryLoads.set(cacheKey, load);
    }
    void load.then((batch) => {
      if (this.historyGeneration !== generation) return;
      this.publishEntries(batch.entries);
      this.historyCursor = batch.cursor;
      this.state.setCursor(batch.cursor);
    }).catch((error) => {
      if (this.historyGeneration !== generation) return;
      this.services.log?.("error", "renderer.history_load.failed", { workspace, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) } });
    }).finally(() => {
      if (this.historyGeneration !== generation) return;
      this.historyLoading = false;
      this.state.setLoading(false);
      this.services.log?.("info", "renderer.history_load.finished", { workspace, cursor: this.historyCursor });
    });
    return () => {
      if (this.historyGeneration === generation) this.historyGeneration += 1;
    };
  }


  readonly refresh = () => {
    if (!this.services.isVisible() || this.refreshPromise || Date.now() - this.lastRefreshAt < 5_000) return this.refreshPromise || Promise.resolve();
    this.lastRefreshAt = Date.now();
    const historyGeneration = this.historyGeneration;
    const recentGeneration = this.recentGeneration;
    const tasks: Array<{ load: Promise<HistoryBatch>; accept: () => boolean; cacheKey?: string }> = [];
    if (this.workspace) tasks.push({
      load: this.fetchMerged(null, 1, 100, { cwd: this.workspace }),
      accept: () => this.historyGeneration === historyGeneration,
      cacheKey: this.initialHistoryCacheKey(this.workspace),
    });
    if (this.recentLoaded) tasks.push({
      load: this.fetchMerged(null, 1, 50, { allWorkspaces: true }),
      accept: () => this.recentGeneration === recentGeneration,
    });
    const refresh = Promise.allSettled(tasks.map((task) => task.load)).then((results) => {
      const entries: HistoryThread[] = [];
      for (const [index, result] of results.entries()) {
        const task = tasks[index];
        if (result.status !== "fulfilled" || !task.accept()) continue;
        entries.push(...result.value.entries);
        if (task.cacheKey) this.mergeInitialHistory(task.cacheKey, result.value, true);
      }
      if (entries.length) this.publishEntries(mergeHistory([], entries));
    }).finally(() => {
      if (this.refreshPromise === refresh) this.refreshPromise = null;
    });
    this.refreshPromise = refresh;
    return refresh;
  };


  readonly loadMore = async () => {
    if (!this.historyCursor || this.historyLoading) return;
    const generation = this.historyGeneration;
    this.historyLoading = true;
    this.state.setLoading(true);
    try {
      const batch = await this.fetchMerged(this.historyCursor, 5, 100, { cwd: this.workspace });
      if (this.historyGeneration !== generation) return;
      this.publishEntries(batch.entries);
      this.historyCursor = batch.cursor;
      this.state.setCursor(batch.cursor);
      this.mergeInitialHistory(this.initialHistoryCacheKey(this.workspace), batch);
    } finally {
      if (this.historyGeneration !== generation) return;
      this.historyLoading = false;
      this.state.setLoading(false);
    }
  };


  readonly loadRecent = async () => {
    if (this.recentLoaded || this.recentLoading) return;
    const generation = ++this.recentGeneration;
    this.recentLoading = true;
    this.state.setRecentLoading(true);
    this.state.setRecentCursor(null);
    try {
      const batch = await this.fetchMerged(null, 1, 50, { allWorkspaces: true });
      if (this.recentGeneration !== generation) return;
      this.publishEntries(batch.entries);
      this.recentCursor = batch.cursor;
      this.recentLoaded = true;
      this.state.setRecentCursor(batch.cursor);

    } catch (error) {
      if (this.recentGeneration !== generation) return;
      this.services.log?.("error", "renderer.recent_history_load.failed", { error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) } });
    } finally {
      if (this.recentGeneration !== generation) return;
      this.recentLoading = false;
      this.state.setRecentLoading(false);
    }
  };

  readonly loadMoreRecent = async () => {
    if (!this.recentCursor || this.recentLoading) return;
    const generation = this.recentGeneration;
    this.recentLoading = true;
    this.state.setRecentLoading(true);
    try {
      const batch = await this.fetchMerged(this.recentCursor, 1, 50, { allWorkspaces: true });
      if (this.recentGeneration !== generation) return;
      this.publishEntries(batch.entries);
      this.recentCursor = batch.cursor;
      this.state.setRecentCursor(batch.cursor);
    } finally {
      if (this.recentGeneration !== generation) return;
      this.recentLoading = false;
      this.state.setRecentLoading(false);
    }
  };

  private searchParams(provider: AgentProvider, cursor: string | null, scope: HistorySearchScope) {
    const scopeParams = scope === "allWorkspaces" ? { allWorkspaces: true } : { cwd: this.workspace };
    return provider === "codex"
      ? { searchTerm: this.searchTerm, cursor, limit: 100, sortKey: "recency_at", sortDirection: "desc", sourceKinds: ["cli", "vscode", "exec", "appServer"], archived: false, ...scopeParams }
      : { searchTerm: this.searchTerm, cursor, limit: 100, ...scopeParams };
  }

  private async searchPage(cursor: string | null, scope: HistorySearchScope) {
    const cursors = decodeHistoryCursor(cursor);
    const providers = (["codex", "claude"] as const).filter((provider) => this.enabledProviders.has(provider) && (cursor === null || cursors[provider] !== null));
    const results = await Promise.allSettled(providers.map((provider) => this.services.request(provider, "searchSessions", this.searchParams(provider, cursors[provider], scope))));
    const values: Array<{ provider: AgentProvider; value: unknown }> = [];
    let firstError: unknown;
    for (const [index, result] of results.entries()) {
      const provider = providers[index];
      if (result.status === "fulfilled") values.push({ provider, value: result.value });
      else {
        firstError ??= result.reason;
        this.logProviderFailure(provider, "searchSessions", result.reason);
      }
    }
    if (!values.length && firstError !== undefined) throw firstError;
    const next = { ...cursors };
    for (const { provider, value } of values) {
      const cursorValue = asRecord(value).nextCursor;
      next[provider] = typeof cursorValue === "string" && cursorValue ? cursorValue : null;
    }
    const entries = applyLocalSessionMetadata(mergeHistory([], values.flatMap(({ value }) => threadFromSearch(value))), this.services.getPreferences());
    return { entries, cursor: encodeHistoryCursor(next) };
  }

  readonly search = async (query: string, scope: HistorySearchScope = "directory") => {
    const searchTerm = query.trim();
    const searchGeneration = ++this.searchGeneration;
    this.searchTerm = searchTerm;
    this.searchScope = scope;
    this.searchCursor = null;
    if (!searchTerm) {
      this.searchLoading = false;
      this.state.setSearchResults(null, false);
      this.state.setSearchCursor(null);
      this.state.setSearchLoading(false);
      return;
    }
    this.searchLoading = true;
    this.state.setSearchLoading(true);
    try {
      const result = await this.searchPage(null, scope);
      if (this.searchGeneration !== searchGeneration || this.searchTerm !== searchTerm || this.searchScope !== scope) return;
      this.searchCursor = result.cursor;
      this.state.setSearchResults(result.entries, false);
      this.state.setSearchCursor(result.cursor);
    } catch {
      if (this.searchGeneration !== searchGeneration || this.searchTerm !== searchTerm || this.searchScope !== scope) return;
      this.searchCursor = null;
      this.state.setSearchResults([], false);
      this.state.setSearchCursor(null);
    } finally {
      if (this.searchGeneration !== searchGeneration || this.searchTerm !== searchTerm || this.searchScope !== scope) return;
      this.searchLoading = false;
      this.state.setSearchLoading(false);
    }
  };

  readonly loadMoreSearch = async () => {
    if (!this.searchTerm || !this.searchCursor || this.searchLoading) return;
    const searchTerm = this.searchTerm;
    const scope = this.searchScope;
    const generation = this.searchGeneration;
    this.searchLoading = true;
    this.state.setSearchLoading(true);
    try {
      const result = await this.searchPage(this.searchCursor, scope);
      if (this.searchGeneration !== generation || this.searchTerm !== searchTerm || this.searchScope !== scope) return;
      this.searchCursor = result.cursor;
      this.state.setSearchResults(result.entries, true);
      this.state.setSearchCursor(result.cursor);
    } finally {
      if (this.searchGeneration !== generation || this.searchTerm !== searchTerm || this.searchScope !== scope) return;
      this.searchLoading = false;
      this.state.setSearchLoading(false);
    }
  };
}
