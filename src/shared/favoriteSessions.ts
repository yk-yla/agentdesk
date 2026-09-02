import type { AgentProvider } from "./agentProtocol";
import type { FavoriteSessionSummary } from "./protocol";

const FAVORITE_SESSION_LIMIT = 2_000;
const FAVORITE_TITLE_LIMIT = 200;
const FAVORITE_PATH_LIMIT = 32_768;

export function favoriteSessionKey(provider: AgentProvider, id: string) {
  return `${provider}:${id}`;
}

export function normalizeFavoriteSessionSummaries(value: unknown): Record<string, FavoriteSessionSummary> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const summaries: Record<string, FavoriteSessionSummary> = {};
  for (const item of Object.values(value)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const provider = record.provider === "codex" || record.provider === "claude" ? record.provider : null;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const title = typeof record.title === "string" ? record.title.trim().slice(0, FAVORITE_TITLE_LIMIT) : "";
    const cwd = typeof record.cwd === "string" ? record.cwd.trim().slice(0, FAVORITE_PATH_LIMIT) : "";
    const updatedAt = typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) && record.updatedAt >= 0 ? record.updatedAt : 0;
    const codexHome = record.codexHome === "agentdesk" || record.codexHome === "default" ? record.codexHome : undefined;
    if (!provider || !id || !cwd) continue;
    summaries[favoriteSessionKey(provider, id)] = { provider, id, title: title || "无标题会话", cwd, updatedAt, ...(provider === "codex" && codexHome ? { codexHome } : {}) };
    if (Object.keys(summaries).length >= FAVORITE_SESSION_LIMIT) break;
  }
  return summaries;
}
