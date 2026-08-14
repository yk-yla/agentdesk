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

export function applyLocalSessionMetadata(entries: HistoryThread[], preferences: DesktopPreferences) {
  const aliases = preferences.sessionAliases || {};
  const favorites = new Set(preferences.favoriteSessions || []);
  return entries.map((entry) => {
    const key = `${entry.provider}:${entry.id}`;
    const title = aliases[key]?.trim() || aliases[entry.id]?.trim() || entry.title;
    return { ...entry, title, titleLower: title.toLowerCase(), isFavorite: favorites.has(key) || favorites.has(entry.id) };
  });
}

export function isFavoriteSession(preferences: DesktopPreferences, provider: AgentProvider, id: string) {
  const favorites = preferences.favoriteSessions || [];
  return favorites.includes(`${provider}:${id}`) || favorites.includes(id);
}

export function favoriteSessionSummary(entry: { provider: AgentProvider; id: string; title: string; cwd: string; updatedAt: number }): FavoriteSessionSummary {
  return { provider: entry.provider, id: entry.id, title: entry.title || "无标题会话", cwd: entry.cwd, updatedAt: entry.updatedAt };
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
  private searchTerm = "";
  private searchCursor: string | null = null;
  private searchLoading = false;
  private historyGeneration = 0;
  private searchGeneration = 0;
  private refreshPromise: Promise<void> | null = null;
  private lastRefreshAt = 0;

  constructor(
    private readonly state: HistoryControllerState,
    private readonly services: HistoryControllerServices,
  ) {}

  private publishEntries(entries: HistoryThread[]) {
    this.state.mergeEntries(applyLocalSessionMetadata(entries, this.services.getPreferences()));
  }

  private logProviderFailure(provider: AgentProvider, operation: "listSessions" | "searchSessions", error: unknown) {
    this.services.log?.("warn", "renderer.history_provider.failed", {
      provider,
      operation,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) },
    });
  }

  private async fetchProvider(provider: AgentProvider, cursor: string | null, maxPages: number, onPage: (entries: HistoryThread[]) => void) {
    let nextCursor = cursor;
    for (let page = 0; page < maxPages; page += 1) {
      const value = await this.services.request(provider, "listSessions", providerHistoryParams(provider, {
        cursor: nextCursor,
        limit: 100,
        cwd: this.workspace,
      }));
      onPage(threadFromList(value));
      const next = asRecord(value).nextCursor;
      nextCursor = typeof next === "string" && next ? next : null;
      if (!nextCursor) break;
    }
    return nextCursor;
  }

  private async fetchMerged(cursor: string | null, maxPages: number, onPage: (entries: HistoryThread[]) => void) {
    const decoded = decodeHistoryCursor(cursor);
    const next = { ...decoded };
    const providers = (["codex", "claude"] as const).filter((provider) => cursor === null || decoded[provider] !== null);
    const results = await Promise.allSettled(providers.map((provider) => this.fetchProvider(provider, decoded[provider], maxPages, onPage)));
    let firstError: unknown;
    let successCount = 0;
    for (const [index, result] of results.entries()) {
      const provider = providers[index];
      if (result.status === "fulfilled") {
        next[provider] = result.value;
        successCount += 1;
      } else {
        firstError ??= result.reason;
        this.logProviderFailure(provider, "listSessions", result.reason);
      }
    }
    if (!successCount && firstError !== undefined) throw firstError;
    return encodeHistoryCursor(next);
  }

  loadInitial(workspace: string) {
    if (!workspace.trim() || workspace === "正在连接工作区" || workspace === "工作区不可用") {
      this.workspace = "";
      this.historyCursor = null;
      this.state.setCursor(null);
      this.historyLoading = false;
      this.state.setLoading(false);
      return () => undefined;
    }
    this.services.log?.("info", "renderer.history_load.started", { workspace });
    this.workspace = workspace;
    this.historyCursor = null;
    this.state.setCursor(null);
    const generation = ++this.historyGeneration;
    this.historyLoading = true;
    this.state.setLoading(true);
    void this.fetchMerged(null, 5, (page) => {
      if (this.historyGeneration === generation) this.publishEntries(page);
    }).then((cursor) => {
      if (this.historyGeneration !== generation) return;
      this.historyCursor = cursor;
      this.state.setCursor(cursor);
    }).catch((error) => {
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
    const generation = this.historyGeneration;
    const refresh = this.fetchMerged(null, 1, (page) => {
      if (this.historyGeneration === generation) this.publishEntries(page);
    }).catch(() => {
      // 保留当前历史，下一次焦点或定时刷新继续尝试。
    }).then(() => undefined).finally(() => {
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
      const cursor = await this.fetchMerged(this.historyCursor, 5, (page) => {
        if (this.historyGeneration === generation) this.publishEntries(page);
      });
      if (this.historyGeneration !== generation) return;
      this.historyCursor = cursor;
      this.state.setCursor(cursor);
    } finally {
      if (this.historyGeneration !== generation) return;
      this.historyLoading = false;
      this.state.setLoading(false);
    }
  };

  private searchParams(provider: AgentProvider, cursor: string | null) {
    return provider === "codex"
      ? { searchTerm: this.searchTerm, cursor, limit: 100, sortKey: "recency_at", sortDirection: "desc", sourceKinds: ["cli", "vscode", "exec", "appServer"], archived: false }
      : { searchTerm: this.searchTerm, cursor, limit: 100, cwd: this.workspace };
  }

  private async searchPage(cursor: string | null) {
    const cursors = decodeHistoryCursor(cursor);
    const providers = (["codex", "claude"] as const).filter((provider) => cursor === null || cursors[provider] !== null);
    const results = await Promise.allSettled(providers.map((provider) => this.services.request(provider, "searchSessions", this.searchParams(provider, cursors[provider]))));
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

  readonly search = async (query: string) => {
    const searchTerm = query.trim();
    const searchGeneration = ++this.searchGeneration;
    this.searchTerm = searchTerm;
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
      const result = await this.searchPage(null);
      if (this.searchGeneration !== searchGeneration || this.searchTerm !== searchTerm) return;
      this.searchCursor = result.cursor;
      this.state.setSearchResults(result.entries, false);
      this.state.setSearchCursor(result.cursor);
    } catch {
      if (this.searchGeneration !== searchGeneration || this.searchTerm !== searchTerm) return;
      this.searchCursor = null;
      this.state.setSearchResults([], false);
      this.state.setSearchCursor(null);
    } finally {
      if (this.searchGeneration !== searchGeneration || this.searchTerm !== searchTerm) return;
      this.searchLoading = false;
      this.state.setSearchLoading(false);
    }
  };

  readonly loadMoreSearch = async () => {
    if (!this.searchTerm || !this.searchCursor || this.searchLoading) return;
    const searchTerm = this.searchTerm;
    const generation = this.searchGeneration;
    this.searchLoading = true;
    this.state.setSearchLoading(true);
    try {
      const result = await this.searchPage(this.searchCursor);
      if (this.searchGeneration !== generation || this.searchTerm !== searchTerm) return;
      this.searchCursor = result.cursor;
      this.state.setSearchResults(result.entries, true);
      this.state.setSearchCursor(result.cursor);
    } finally {
      if (this.searchGeneration !== generation || this.searchTerm !== searchTerm) return;
      this.searchLoading = false;
      this.state.setSearchLoading(false);
    }
  };
}
