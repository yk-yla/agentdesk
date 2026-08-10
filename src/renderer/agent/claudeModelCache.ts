import type { ClaudeModelCache, ClaudeModelCacheModel } from "../../shared/protocol";
import type { ModelOption } from "../domain";

// Schema 2 invalidates caches created before Provider-specific session state was isolated.
export const CLAUDE_MODEL_CACHE_SCHEMA = 2 as const;
export const CLAUDE_MODEL_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_MODELS = 64;

function normalizeModel(value: unknown): ModelOption | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<ClaudeModelCacheModel>;
  if (typeof record.id !== "string" || !record.id || typeof record.displayName !== "string" || !record.displayName) return null;
  const efforts = Array.isArray(record.efforts) ? record.efforts.filter((entry): entry is string => typeof entry === "string").slice(0, 8) : [];
  return {
    id: record.id,
    ...(typeof record.resolvedId === "string" && record.resolvedId ? { resolvedId: record.resolvedId } : {}),
    displayName: record.displayName,
    description: typeof record.description === "string" ? record.description : "",
    efforts,
    defaultEffort: typeof record.defaultEffort === "string" ? record.defaultEffort : efforts[0] || "",
    supportsImage: record.supportsImage !== false,
  };
}

export function usableClaudeCachedModels(cache: unknown, currentVersion?: string, now = Date.now()) {
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) return [];
  const record = cache as Partial<ClaudeModelCache>;
  if (record.schema !== CLAUDE_MODEL_CACHE_SCHEMA || typeof record.claudeVersion !== "string" || !record.claudeVersion || record.claudeVersion === "unknown" || !Number.isSafeInteger(record.updatedAt)) return [];
  if (Number(record.updatedAt) <= 0 || Number(record.updatedAt) > now + 5 * 60_000 || now - Number(record.updatedAt) > CLAUDE_MODEL_CACHE_TTL_MS) return [];
  if (currentVersion && currentVersion !== "unknown" && record.claudeVersion !== currentVersion) return [];
  if (!Array.isArray(record.models) || record.models.length === 0 || record.models.length > MAX_MODELS) return [];
  const models = record.models.map(normalizeModel).filter((model): model is ModelOption => Boolean(model));
  return models.length === record.models.length ? models : [];
}

export function createClaudeModelCache(models: ModelOption[], claudeVersion: string, now = Date.now()): ClaudeModelCache | undefined {
  const normalized = models.slice(0, MAX_MODELS).map((model): ClaudeModelCacheModel => ({
    id: model.id,
    ...(model.resolvedId ? { resolvedId: model.resolvedId } : {}),
    displayName: model.displayName,
    description: model.description,
    efforts: model.efforts.slice(0, 8),
    defaultEffort: model.defaultEffort,
    supportsImage: model.supportsImage,
  }));
  const version = claudeVersion.trim();
  if (!normalized.length || !version || version === "unknown") return undefined;
  return { schema: CLAUDE_MODEL_CACHE_SCHEMA, claudeVersion: version, updatedAt: now, models: normalized };
}

export function sameClaudeModelCache(left: ClaudeModelCache | undefined, right: ClaudeModelCache | undefined) {
  if (!left || !right) return left === right;
  return left.schema === right.schema && left.claudeVersion === right.claudeVersion && JSON.stringify(left.models) === JSON.stringify(right.models);
}
