import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BASE_FONT_SIZE, MAX_BASE_FONT_SIZE, MIN_BASE_FONT_SIZE, type ClaudeModelCache, type ClaudeModelCacheModel, type CompactionRecord, type DesktopPreferences, type DisplayMode, type ThemeId } from "../shared/protocol";
import { DEFAULT_BOSS_KEY, normalizeBossKeyAccelerator } from "../shared/bossKey";
import { normalizeFavoriteSessionSummaries } from "../shared/favoriteSessions";
import { writeTextFileAtomic } from "./atomicFile";

const MAX_PREFERENCES_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_CONTEXT_WINDOW_CACHE_ENTRIES = 256;
const MAX_CLAUDE_MODEL_CACHE_MODELS = 64;
const CLAUDE_MODEL_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_COMPACTION_COUNT_ENTRIES = 512;
const MAX_COMPACTION_EVENT_IDS = 64;
const MAX_RECENT_COMMAND_USAGE_ENTRIES = 512;

export const DEFAULT_PREFERENCES: DesktopPreferences = {
  recentWorkspaces: [],
  lastWorkspace: "",
  favoriteWorkspaces: [],
  sidebarWidth: 250,
  baseFontSize: DEFAULT_BASE_FONT_SIZE,
  sessionAliases: {},
  favoriteSessions: [],
  favoriteSessionSummaries: {},
  modelContextWindows: {},
  lastReasoningEfforts: {},
  recentCommandUsage: {},
  compactionCounts: {},
  codexCompactionCounts: {},
  theme: "github-light",
  displayMode: "simple",
  bossKey: DEFAULT_BOSS_KEY,
};

const THEME_IDS: ThemeId[] = [
  "github-light", "modern-dark", "github-dark-dimmed",
];

export function normalizeTheme(value: unknown): ThemeId {
  return typeof value === "string" && THEME_IDS.includes(value as ThemeId) ? value as ThemeId : DEFAULT_PREFERENCES.theme;
}

export function normalizeDisplayMode(value: unknown): DisplayMode {
  return value === "full" || value === "standard" || value === "raw" ? "full" : "simple";
}

export function normalizeSidebarWidth(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(184, Math.min(480, Math.round(value)))
    : 250;
}

export function normalizeBaseFontSize(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(MIN_BASE_FONT_SIZE, Math.min(MAX_BASE_FONT_SIZE, Math.round(value)))
    : DEFAULT_BASE_FONT_SIZE;
}

export function normalizeLastReasoningEfforts(value: unknown): NonNullable<DesktopPreferences["lastReasoningEfforts"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries((["codex", "claude"] as const).flatMap((provider) => {
    const effort = typeof record[provider] === "string" ? record[provider].trim() : "";
    return effort && effort.length <= 32 ? [[provider, effort]] : [];
  }));
}

export function normalizeRecentCommandUsage(value: unknown): NonNullable<DesktopPreferences["recentCommandUsage"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, timestamp]) => /^(command|skill):.+$/u.test(key) && key.length <= 512 && typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, MAX_RECENT_COMMAND_USAGE_ENTRIES)) as Record<string, number>;
}

export function normalizeCompactionCounts(value: unknown): NonNullable<DesktopPreferences["compactionCounts"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, raw]) => {
      const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const count = typeof record.count === "number" && Number.isSafeInteger(record.count) ? record.count : 0;
      const eventIds = Array.isArray(record.eventIds)
        ? [...new Set(record.eventIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 240))].slice(-MAX_COMPACTION_EVENT_IDS)
        : [];
      const updatedAt = typeof record.updatedAt === "number" && Number.isSafeInteger(record.updatedAt) && record.updatedAt > 0 ? record.updatedAt : 0;
      return [key, { count: Math.max(count, eventIds.length), eventIds, updatedAt } satisfies CompactionRecord] as const;
    })
    .filter(([key, record]) => key.length > 0 && key.length <= 512 && record.count > 0 && record.count <= 10_000_000)
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, MAX_COMPACTION_COUNT_ENTRIES));
}

/** 旧名称保留给 IPC 和已有调用方，实际使用同一套 Provider 无关归一化。 */
export const normalizeCodexCompactionCounts = normalizeCompactionCounts;

export function normalizeModelContextWindows(value: unknown): NonNullable<DesktopPreferences["modelContextWindows"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([model, rawEntry]) => {
      const entry = rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry) ? rawEntry as Record<string, unknown> : {};
      return [model, { tokens: entry.tokens, updatedAt: entry.updatedAt }] as const;
    })
    .filter((entry): entry is readonly [string, { tokens: number; updatedAt: number }] => (
      entry[0].length > 0
      && entry[0].length <= 240
      && typeof entry[1].tokens === "number"
      && Number.isSafeInteger(entry[1].tokens)
      && entry[1].tokens > 0
      && typeof entry[1].updatedAt === "number"
      && Number.isSafeInteger(entry[1].updatedAt)
      && entry[1].updatedAt > 0
    ))
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, MAX_MODEL_CONTEXT_WINDOW_CACHE_ENTRIES));
}

function normalizeClaudeModel(value: unknown): ClaudeModelCacheModel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const model = value as Record<string, unknown>;
  const id = typeof model.id === "string" ? model.id.trim() : "";
  const displayName = typeof model.displayName === "string" ? model.displayName.trim() : "";
  if (!id || id.length > 240 || !displayName || displayName.length > 240) return null;
  const efforts = Array.isArray(model.efforts)
    ? model.efforts.filter((entry): entry is string => typeof entry === "string" && entry.length <= 32).slice(0, 8)
    : [];
  const description = typeof model.description === "string" ? model.description.slice(0, 1_000) : "";
  const resolvedId = typeof model.resolvedId === "string" && model.resolvedId.trim().length <= 240 ? model.resolvedId.trim() : undefined;
  const defaultEffort = typeof model.defaultEffort === "string" && model.defaultEffort.length <= 32 ? model.defaultEffort : "";
  return { id, ...(resolvedId ? { resolvedId } : {}), displayName, description, efforts, defaultEffort, supportsImage: model.supportsImage !== false };
}

export function normalizeClaudeModelCache(value: unknown, now = Date.now()): ClaudeModelCache | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cache = value as Record<string, unknown>;
  if (cache.schema !== 2 || typeof cache.claudeVersion !== "string" || !cache.claudeVersion.trim() || cache.claudeVersion.trim() === "unknown" || cache.claudeVersion.length > 128) return undefined;
  if (!Number.isSafeInteger(cache.updatedAt) || Number(cache.updatedAt) <= 0 || Number(cache.updatedAt) > now + 5 * 60_000 || now - Number(cache.updatedAt) > CLAUDE_MODEL_CACHE_TTL_MS) return undefined;
  if (!Array.isArray(cache.models) || cache.models.length === 0 || cache.models.length > MAX_CLAUDE_MODEL_CACHE_MODELS) return undefined;
  const models = cache.models.map(normalizeClaudeModel).filter((model): model is ClaudeModelCacheModel => Boolean(model));
  return models.length === cache.models.length ? { schema: 2, claudeVersion: cache.claudeVersion.trim(), updatedAt: Number(cache.updatedAt), models } : undefined;
}

export function normalizePreferences(value: unknown): DesktopPreferences {
  const parsed = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<DesktopPreferences>
    : {};
  const claudeModelCache = normalizeClaudeModelCache(parsed.claudeModelCache);
  const preferences: DesktopPreferences = {
    ...DEFAULT_PREFERENCES,
    theme: normalizeTheme(parsed.theme),
    displayMode: normalizeDisplayMode(parsed.displayMode),
    bossKey: normalizeBossKeyAccelerator(parsed.bossKey) || DEFAULT_BOSS_KEY,
    recentWorkspaces: Array.isArray(parsed.recentWorkspaces) ? parsed.recentWorkspaces.filter((item): item is string => typeof item === "string").slice(0, 32) : [],
    lastWorkspace: typeof parsed.lastWorkspace === "string"
      ? parsed.lastWorkspace
      : Array.isArray(parsed.recentWorkspaces) && typeof parsed.recentWorkspaces[0] === "string" ? parsed.recentWorkspaces[0] : "",
    favoriteWorkspaces: Array.isArray(parsed.favoriteWorkspaces) ? parsed.favoriteWorkspaces.filter((item): item is string => typeof item === "string").slice(0, 32) : [],
    sidebarWidth: normalizeSidebarWidth(parsed.sidebarWidth),
    baseFontSize: normalizeBaseFontSize(parsed.baseFontSize),
    sessionAliases: parsed.sessionAliases && typeof parsed.sessionAliases === "object" && !Array.isArray(parsed.sessionAliases)
      ? Object.fromEntries(Object.entries(parsed.sessionAliases).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0).slice(0, 2_000))
      : {},
    favoriteSessions: Array.isArray(parsed.favoriteSessions) ? parsed.favoriteSessions.filter((item): item is string => typeof item === "string").slice(0, 2_000) : [],
    favoriteSessionSummaries: normalizeFavoriteSessionSummaries(parsed.favoriteSessionSummaries),
    modelContextWindows: normalizeModelContextWindows(parsed.modelContextWindows),
    ...(claudeModelCache ? { claudeModelCache } : {}),
    lastReasoningEfforts: normalizeLastReasoningEfforts(parsed.lastReasoningEfforts),
    recentCommandUsage: normalizeRecentCommandUsage(parsed.recentCommandUsage),
    compactionCounts: normalizeCompactionCounts({
      ...normalizeCompactionCounts(parsed.codexCompactionCounts),
      ...normalizeCompactionCounts(parsed.compactionCounts),
    }),
    codexCompactionCounts: normalizeCompactionCounts(parsed.codexCompactionCounts),
  };
  if (parsed.workspaceState && typeof parsed.workspaceState === "object" && !Array.isArray(parsed.workspaceState)) {
    preferences.workspaceState = parsed.workspaceState;
  }
  return preferences;
}

export class PreferencesStore {
  constructor(private readonly resolvePath: () => string) {}

  read(): DesktopPreferences {
    try {
      const filePath = this.resolvePath();
      if (statSync(filePath).size > MAX_PREFERENCES_BYTES) return normalizePreferences({});
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      return normalizePreferences(parsed);
    } catch {
      return normalizePreferences({});
    }
  }

  write(patch: Partial<DesktopPreferences>) {
    const next = normalizePreferences({ ...this.read(), ...patch });
    const filePath = this.resolvePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    const serialized = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(serialized, "utf8") > MAX_PREFERENCES_BYTES) throw new Error("本地偏好数据过大，请先减少草稿或排队消息。");
    writeTextFileAtomic(filePath, serialized);
    return next;
  }
}
