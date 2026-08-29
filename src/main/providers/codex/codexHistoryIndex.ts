import { createReadStream, watch, type FSWatcher } from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { canonicalWorkspace, isWithinDirectory } from "../../localPathPolicy";
import type { AppLogger } from "../../logger";
import { writeTextFileAtomicAsync } from "../../atomicFile";

const INDEX_SCHEMA = 1;
// Codex uses UUIDv7 today, but older installations may contain other UUID
// versions. The filename is the source of truth for the native thread id.
const SESSION_FILE_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const MAX_INDEXED_TEXT_CHARS = 512 * 1024;
const MAX_INDEXED_TEXT_TOTAL_CHARS = 256 * 1024 * 1024;
const MAX_INDEXED_SESSIONS = 20_000;
const MAX_INDEX_FILE_BYTES = 512 * 1024 * 1024;
const BACKGROUND_START_DELAY_MS = 1_500;
const BACKGROUND_FILE_PAUSE_MS = 80;
const PARSE_YIELD_BYTES = 256 * 1024;
const PARSE_YIELD_DELAY_MS = 4;
const PERSIST_DEBOUNCE_MS = 15_000;
const WATCH_DEBOUNCE_MS = 800;
const REFRESH_INTERVAL_MS = 5 * 60_000;
const MAX_SEARCH_SNIPPET_CHARS = 800;

const TEXT_KEYS = new Set([
  "text", "content", "message", "prompt", "input", "output", "preview", "name", "summary", "customTitle", "firstPrompt", "lastAgentMessage",
]);
const STRUCTURAL_KEYS = new Set(["payload", "items", "parts", "blocks", "message", "content", "input", "output"]);

interface PersistedEntry {
  path: string;
  id: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  mtimeMs: number;
  size: number;
  text: string;
  truncated: boolean;
}

interface IndexedEntry extends PersistedEntry {
  source?: string;
}

interface PersistedIndex {
  schema: number;
  entries: PersistedEntry[];
}

export interface CodexHistoryIndexOptions {
  roots: string[];
  storagePath: () => string;
  isWorkspaceAuthorized?: (cwd: string) => boolean;
  logger?: AppLogger;
  startDelayMs?: number;
}

export interface CodexHistorySearchParams {
  searchTerm?: unknown;
  cwd?: unknown;
  allWorkspaces?: unknown;
  limit?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sessionIdFromPath(filePath: string) {
  return SESSION_FILE_PATTERN.exec(path.basename(filePath))?.[1] || "";
}

function timestampValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function appendText(parts: string[], state: { length: number; truncated: boolean }, value: string) {
  const text = value.trim();
  if (!text || state.length >= MAX_INDEXED_TEXT_CHARS) {
    if (text) state.truncated = true;
    return;
  }
  const remaining = MAX_INDEXED_TEXT_CHARS - state.length;
  const clipped = text.slice(0, remaining);
  parts.push(clipped);
  state.length += clipped.length + 1;
  if (clipped.length < text.length) state.truncated = true;
}

function collectVisibleText(value: unknown, parts: string[], state: { length: number; truncated: boolean }, depth = 0, key = "") {
  if (depth > 10 || state.length >= MAX_INDEXED_TEXT_CHARS || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (TEXT_KEYS.has(key) || key === "") appendText(parts, state, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectVisibleText(child, parts, state, depth + 1, key);
    return;
  }
  if (typeof value !== "object") return;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    if (childKey === "encrypted_content" || childKey === "encryptedContent") continue;
    if (TEXT_KEYS.has(childKey) || STRUCTURAL_KEYS.has(childKey)) collectVisibleText(child, parts, state, depth + 1, childKey);
  }
}

function snippetFor(text: string, needle: string) {
  const lowerText = text.toLocaleLowerCase();
  const index = lowerText.indexOf(needle.toLocaleLowerCase());
  if (index < 0) return text.slice(0, MAX_SEARCH_SNIPPET_CHARS);
  return text.slice(Math.max(0, index - 240), Math.max(0, index - 240) + MAX_SEARCH_SNIPPET_CHARS);
}

function titleFor(text: string) {
  return text.replace(/\s+/gu, " ").trim().slice(0, 200) || "本地历史会话";
}

async function walkSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await fsPromises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && /\.jsonl$/i.test(entry.name) && sessionIdFromPath(target)) files.push(target);
    }
  };
  await visit(root);
  // Process newer date directories first so a partial first-run index is
  // useful quickly, even when old history is large.
  return files.sort((left, right) => right.localeCompare(left));
}

async function parseSessionFile(filePath: string, stat: { size: number; mtimeMs: number }, shouldStop?: () => boolean): Promise<IndexedEntry | null> {
  const id = sessionIdFromPath(filePath);
  if (!id || stat.size > MAX_INDEX_FILE_BYTES) return null;
  const parts: string[] = [];
  const state = { length: 0, truncated: false };
  let cwd = "";
  let createdAt = 0;
  let updatedAt = 0;
  let firstText = "";
  let bytesSinceYield = 0;
  try {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (shouldStop?.()) return null;
      bytesSinceYield += Buffer.byteLength(line, "utf8") + 1;
      if (bytesSinceYield >= PARSE_YIELD_BYTES) {
        bytesSinceYield = 0;
        await new Promise<void>((resolve) => setTimeout(resolve, PARSE_YIELD_DELAY_MS));
      }
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      const record = asRecord(parsed);
      const payload = asRecord(record.payload);
      const lineCwd = stringValue(payload.cwd) || stringValue(record.cwd);
      if (!cwd && lineCwd) {
        try { cwd = canonicalWorkspace(lineCwd); } catch { cwd = lineCwd; }
      }
      const lineTime = timestampValue(record.timestamp) || timestampValue(payload.timestamp) || timestampValue(payload.createdAt);
      if (lineTime) {
        createdAt = createdAt ? Math.min(createdAt, lineTime) : lineTime;
        updatedAt = Math.max(updatedAt, lineTime);
      }
      const before = parts.length;
      collectVisibleText(record, parts, state);
      if (!firstText && parts.length > before) firstText = parts[before];
    }
    lines.close();
    stream.destroy();
  } catch {
    return null;
  }
  const text = parts.join("\n");
  return {
    path: filePath,
    id,
    cwd,
    title: titleFor(firstText || text),
    createdAt: createdAt || stat.mtimeMs,
    updatedAt: updatedAt || stat.mtimeMs,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    text,
    truncated: state.truncated,
  };
}

function validPersistedEntry(value: unknown): value is PersistedEntry {
  const entry = asRecord(value);
  return typeof entry.path === "string" && typeof entry.id === "string" && Boolean(entry.id)
    && typeof entry.cwd === "string" && typeof entry.title === "string"
    && typeof entry.createdAt === "number" && typeof entry.updatedAt === "number"
    && typeof entry.mtimeMs === "number" && typeof entry.size === "number"
    && typeof entry.text === "string" && typeof entry.truncated === "boolean";
}

export class CodexHistoryIndex {
  private readonly roots: string[];
  private readonly entries = new Map<string, IndexedEntry>();
  private readonly pendingPaths = new Set<string>();
  private readonly watchers: FSWatcher[] = [];
  private loadPromise: Promise<void> | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private started = false;
  private closed = false;
  private scanning = false;

  constructor(private readonly options: CodexHistoryIndexOptions) {
    this.roots = [...new Set(options.roots.map((root) => path.resolve(root)))];
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.loadPromise = this.loadPersisted();
    void this.loadPromise.then(() => {
      if (this.closed) return;
      this.watchRoots();
      this.startTimer = setTimeout(() => {
        this.startTimer = null;
        void this.scanBackground();
      }, this.options.startDelayMs ?? BACKGROUND_START_DELAY_MS);
      this.startTimer.unref?.();
      this.refreshTimer = setInterval(() => { void this.refreshRoots(); }, REFRESH_INTERVAL_MS);
      this.refreshTimer.unref?.();
    });
  }

  async close() {
    this.closed = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.watchers.splice(0).forEach((watcher) => watcher.close());
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    await this.persist();
  }

  async refreshNow() {
    if (this.closed) return;
    await this.refreshRoots();
    await this.processPendingPaths();
  }

  observeThreads(value: unknown) {
    const result = asRecord(value);
    const data = Array.isArray(result.data) ? result.data : [];
    let changed = false;
    for (const item of data) {
      const record = asRecord(item);
      const thread = asRecord(record.thread);
      const candidate = Object.keys(thread).length ? thread : record;
      const id = stringValue(candidate.id) || stringValue(candidate.sessionId);
      if (!id) continue;
      const entry = [...this.entries.values()].find((current) => current.id === id);
      if (!entry) continue;
      const cwd = stringValue(candidate.cwd);
      if (cwd) {
        const canonicalCwd = canonicalWorkspace(cwd);
        if (entry.cwd !== canonicalCwd) {
          entry.cwd = canonicalCwd;
          changed = true;
        }
      }
      const title = stringValue(candidate.name) || stringValue(candidate.preview);
      if (title) {
        const nextTitle = title.slice(0, 200);
        if (entry.title !== nextTitle) {
          entry.title = nextTitle;
          changed = true;
        }
      }
      const updatedAt = timestampValue(candidate.updatedAt) || timestampValue(candidate.recencyAt);
      if (updatedAt && entry.updatedAt !== updatedAt) {
        entry.updatedAt = updatedAt;
        changed = true;
      }
      const createdAt = timestampValue(candidate.createdAt);
      if (createdAt && entry.createdAt !== createdAt) {
        entry.createdAt = createdAt;
        changed = true;
      }
    }
    if (changed) this.schedulePersist();
  }

  async search(params: CodexHistorySearchParams) {
    await this.loadPromise;
    const needle = stringValue(params.searchTerm).trim();
    if (!needle) return { data: [], nextCursor: null };
    const allWorkspaces = params.allWorkspaces === true;
    const requestedCwd = !allWorkspaces && stringValue(params.cwd).trim() ? canonicalWorkspace(stringValue(params.cwd)) : "";
    const limit = Math.min(Math.max(Math.floor(numberValue(params.limit)) || 100, 1), 100);
    const matches = [...this.entries.values()]
      .filter((entry) => entry.cwd && (!requestedCwd || entry.cwd.toLowerCase() === requestedCwd.toLowerCase()))
      .filter((entry) => !this.options.isWorkspaceAuthorized || this.options.isWorkspaceAuthorized(entry.cwd))
      .filter((entry) => entry.text.toLocaleLowerCase().includes(needle.toLocaleLowerCase()))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
      .map((entry) => ({
        thread: {
          id: entry.id,
          sessionId: entry.id,
          cwd: entry.cwd,
          name: entry.title,
          preview: entry.title,
          createdAt: Math.floor(entry.createdAt / 1000),
          updatedAt: Math.floor(entry.updatedAt / 1000),
          recencyAt: Math.floor(entry.updatedAt / 1000),
          source: "localIndex",
          path: entry.path,
        },
        snippet: snippetFor(entry.text, needle),
      }));
    return { data: matches, nextCursor: null };
  }

  private async loadPersisted() {
    try {
      const parsed = JSON.parse(await fsPromises.readFile(this.options.storagePath(), "utf8")) as PersistedIndex;
      if (parsed?.schema !== INDEX_SCHEMA || !Array.isArray(parsed.entries)) return;
      for (const value of parsed.entries) {
        if (!validPersistedEntry(value) || !this.allowedPath(value.path)) continue;
        this.entries.set(value.path, { ...value });
      }
      this.enforceBounds();
      this.options.logger?.log("info", "codex.history_index.loaded", { entries: this.entries.size });
    } catch {
      // A missing or corrupt cache is rebuilt from the source history files.
    }
  }

  private allowedPath(filePath: string) {
    const resolved = path.resolve(filePath);
    return this.roots.some((root) => isWithinDirectory(resolved, root));
  }

  private watchRoots() {
    for (const root of this.roots) {
      try {
        const watcher = watch(root, { recursive: true }, (_event, fileName) => {
          if (typeof fileName !== "string" || !fileName) return;
          this.queuePath(path.join(root, fileName));
        });
        this.watchers.push(watcher);
      } catch {
        // The periodic refresh still catches changes when recursive watching is unavailable.
      }
    }
  }

  private queuePath(filePath: string) {
    if (!this.allowedPath(filePath) || !/\.jsonl$/i.test(filePath)) return;
    this.pendingPaths.add(path.resolve(filePath));
    const timer = setTimeout(() => { void this.processPendingPaths(); }, WATCH_DEBOUNCE_MS);
    timer.unref?.();
  }

  private async processPendingPaths() {
    if (this.closed || this.scanning) return;
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();
    for (const filePath of paths) await this.indexPath(filePath);
    if (paths.length) this.schedulePersist();
  }

  private async refreshRoots() {
    if (this.closed || this.scanning) return;
    for (const root of this.roots) {
      let rootStat;
      try {
        rootStat = await fsPromises.stat(root);
      } catch {
        continue;
      }
      if (!rootStat.isDirectory()) continue;
      const files = await walkSessionFiles(root);
      const seen = new Set(files.map((filePath) => path.resolve(filePath)));
      for (const filePath of files) this.queuePath(filePath);
      let removed = false;
      for (const indexedPath of this.entries.keys()) {
        if (!isWithinDirectory(indexedPath, root) || seen.has(path.resolve(indexedPath))) continue;
        this.entries.delete(indexedPath);
        removed = true;
      }
      if (removed) this.schedulePersist();
    }
  }

  private async scanBackground() {
    if (this.closed || this.scanning) return;
    this.scanning = true;
    let processed = 0;
    try {
      const files = (await Promise.all(this.roots.map((root) => walkSessionFiles(root))))
        .flat()
        .sort((left, right) => right.localeCompare(left));
      this.options.logger?.log("info", "codex.history_index.scan_started", { files: files.length });
      for (const filePath of files) {
        if (this.closed) return;
        await this.indexPath(filePath);
        processed += 1;
        if (processed % 10 === 0) this.schedulePersist();
        await new Promise<void>((resolve) => setTimeout(resolve, BACKGROUND_FILE_PAUSE_MS));
      }
      this.schedulePersist();
      this.options.logger?.log("info", "codex.history_index.scan_finished", { entries: this.entries.size, processed });
    } finally {
      this.scanning = false;
      if (!this.closed && this.pendingPaths.size) void this.processPendingPaths();
    }
  }

  private async indexPath(filePath: string) {
    let stat;
    try { stat = await fsPromises.stat(filePath); } catch {
      this.entries.delete(filePath);
      return;
    }
    if (!stat.isFile() || !sessionIdFromPath(filePath)) return;
    const existing = this.entries.get(filePath);
    if (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) return;
    const parsed = await parseSessionFile(filePath, { size: stat.size, mtimeMs: stat.mtimeMs }, () => this.closed);
    if (!parsed) return;
    this.entries.set(filePath, parsed);
    this.enforceBounds();
  }

  private enforceBounds() {
    const newestFirst = [...this.entries.values()].sort((left, right) => right.updatedAt - left.updatedAt);
    let textChars = 0;
    for (let index = 0; index < newestFirst.length; index += 1) {
      const entry = newestFirst[index];
      if (index >= MAX_INDEXED_SESSIONS || textChars + entry.text.length > MAX_INDEXED_TEXT_TOTAL_CHARS) {
        this.entries.delete(entry.path);
        continue;
      }
      textChars += entry.text.length;
    }
  }

  private schedulePersist() {
    if (this.closed || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  private async persist() {
    const payload: PersistedIndex = { schema: INDEX_SCHEMA, entries: [...this.entries.values()].map(({ source: _source, ...entry }) => entry) };
    try {
      await fsPromises.mkdir(path.dirname(this.options.storagePath()), { recursive: true });
      await writeTextFileAtomicAsync(this.options.storagePath(), JSON.stringify(payload));
    } catch (error) {
      this.options.logger?.log("warn", "codex.history_index.persist_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export const codexHistoryIndexInternals = {
  parseSessionFile,
  collectVisibleText,
  walkSessionFiles,
};
