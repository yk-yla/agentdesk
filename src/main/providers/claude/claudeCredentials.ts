import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ClaudeCredentialSnapshot {
  baseUrl?: string;
  authToken?: string;
  apiKey?: string;
  source: "settings" | "process" | "native";
}

export interface ClaudeCredentialFields {
  ANTHROPIC_BASE_URL?: unknown;
  ANTHROPIC_AUTH_TOKEN?: unknown;
  ANTHROPIC_API_KEY?: unknown;
}

export interface ClaudeCredentialReadOptions {
  settingsFile?: string;
  processEnv?: NodeJS.ProcessEnv;
}

function settingsPath() {
  return path.join(homedir(), ".claude", "settings.json");
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function validatedBaseUrl(value: unknown, source: ClaudeCredentialSnapshot["source"]) {
  const field = stringField(value);
  if (!field) return undefined;
  let url: URL;
  try { url = new URL(field); } catch { throw new Error("Claude ANTHROPIC_BASE_URL 不是有效 URL。"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) {
    throw new Error("Claude ANTHROPIC_BASE_URL 必须是无用户信息的 HTTP(S) 地址。" );
  }
  return url.toString().replace(/\/$/, "");
}

export function parseClaudeCredentialFields(fields: ClaudeCredentialFields, source: ClaudeCredentialSnapshot["source"]): ClaudeCredentialSnapshot {
  if (source === "native") return { source };
  const baseUrl = validatedBaseUrl(fields.ANTHROPIC_BASE_URL, source);
  const authToken = stringField(fields.ANTHROPIC_AUTH_TOKEN);
  const apiKey = stringField(fields.ANTHROPIC_API_KEY);
  if (authToken && apiKey) throw new Error(`Claude 凭据冲突：${source === "settings" ? "settings.json" : "进程环境"} 同时存在 ANTHROPIC_AUTH_TOKEN 和 ANTHROPIC_API_KEY。请只保留一个。`);
  if (!authToken && !apiKey) throw new Error(`Claude ${source === "settings" ? "settings.json" : "进程环境"} 缺少 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY。`);
  return { ...(baseUrl ? { baseUrl } : {}), authToken: authToken || undefined, apiKey: apiKey || undefined, source };
}

function credentialFieldsAvailable(fields: ClaudeCredentialFields) {
  return Boolean(stringField(fields.ANTHROPIC_AUTH_TOKEN) || stringField(fields.ANTHROPIC_API_KEY));
}

/** 每次 Query 创建前重新读取；不缓存、不改写 process.env。 */
export function readClaudeCredentials(options: ClaudeCredentialReadOptions = {}): ClaudeCredentialSnapshot {
  const processEnv = options.processEnv ?? process.env;
  const filePath = options.settingsFile || settingsPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") parsed = undefined;
    else throw new Error("Claude settings.json 无法读取或不是有效 JSON。");
  }
  if (parsed !== undefined) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Claude settings.json 格式无效。");
    const env = (parsed as Record<string, unknown>).env;
    if (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env))) throw new Error("Claude settings.json 的 env 必须是对象。" );
    if (env && credentialFieldsAvailable(env as ClaudeCredentialFields)) return parseClaudeCredentialFields(env as ClaudeCredentialFields, "settings");
  }
  if (credentialFieldsAvailable(processEnv)) return parseClaudeCredentialFields(processEnv, "process");
  return { source: "native" };
}

export function credentialEnv(snapshot: ClaudeCredentialSnapshot) {
  const env: Record<string, string> = {};
  if (snapshot.baseUrl) env.ANTHROPIC_BASE_URL = snapshot.baseUrl;
  if (snapshot.authToken) env.ANTHROPIC_AUTH_TOKEN = snapshot.authToken;
  if (snapshot.apiKey) env.ANTHROPIC_API_KEY = snapshot.apiKey;
  return env;
}

export function hasClaudeCredential(snapshot: ClaudeCredentialSnapshot) {
  return snapshot.source === "native" || Boolean(snapshot.authToken || snapshot.apiKey);
}
