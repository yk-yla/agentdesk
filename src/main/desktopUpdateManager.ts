import type { DesktopReleaseNote, DesktopUpdateStatus } from "../shared/protocol";

const UPDATE_OWNER = "yk-yla";
const UPDATE_REPOSITORY = "agentdesk";
const UPDATE_REPOSITORY_URL = `https://github.com/${UPDATE_OWNER}/${UPDATE_REPOSITORY}`;
const MAX_RELEASE_NOTES = 20;
const MAX_RELEASE_NOTE_LENGTH = 8_000;
const MAX_RELEASE_NOTES_BYTES = 64 * 1024;

interface UpdateInfo {
  version: string;
  releaseNotes?: string | Array<{ version?: unknown; note?: unknown }> | null;
}

interface DesktopUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  fullChangelog: boolean;
  logger: unknown;
  on(event: "update-available", listener: (info: UpdateInfo) => void): unknown;
  on(event: "update-not-available", listener: (info: UpdateInfo) => void): unknown;
  on(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  setFeedURL(options: { provider: "github"; owner: string; repo: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}

export interface DesktopUpdateManagerDependencies {
  updater: DesktopUpdater;
  currentVersion(): string;
  isPackaged(): boolean;
  emitStatus(status: DesktopUpdateStatus): void;
  prepareInstall(): Promise<void>;
  scheduleInstall(run: () => void): void;
}

export function desktopUpdateErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/404|not found|no published versions|latest version/i.test(message)) return "GitHub 还没有可用的正式版本，请先发布一个版本。";
  if (/401|403|unauthorized|forbidden|rate limit/i.test(message)) return "更新服务器暂时拒绝请求，请稍后重试。";
  if (/net::|network|fetch|socket|timeout|timed out|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(message)) return "无法连接 GitHub（需要外网环境），请确认网络可以访问 github.com 后重试，或联系 IT 同事协助。";
  return "更新操作失败，请稍后重试。";
}

export class DesktopUpdateManager {
  private initialized = false;
  private busy = false;
  private disposed = false;
  private status: DesktopUpdateStatus = {
    phase: "idle",
    currentVersion: "",
    message: "等待检查更新。",
    repositoryUrl: UPDATE_REPOSITORY_URL,
  };

  constructor(private readonly dependencies: DesktopUpdateManagerDependencies) {}

  initialize() {
    if (this.disposed || !this.dependencies.isPackaged()) return;
    this.initializeUpdater();
  }

  dispose() {
    this.disposed = true;
  }

  currentStatus() {
    this.status = {
      ...this.status,
      currentVersion: this.dependencies.currentVersion(),
    };
    return { ...this.status };
  }

  setStatus(patch: Partial<DesktopUpdateStatus>) {
    this.status = {
      ...this.status,
      ...patch,
      currentVersion: this.dependencies.currentVersion(),
      repositoryUrl: UPDATE_REPOSITORY_URL,
    };
    const status = { ...this.status };
    this.dependencies.emitStatus(status);
    return status;
  }

  async check() {
    if (this.disposed) return this.currentStatus();
    if (!this.dependencies.isPackaged()) return this.setStatus({ phase: "unsupported", message: "开发环境不检查软件更新。", progress: undefined });
    if (this.busy) return this.currentStatus();
    this.initializeUpdater();
    this.busy = true;
    this.setStatus({ phase: "checking", availableVersion: undefined, releaseNotes: undefined, message: "正在检查新版本。", progress: undefined });
    try {
      this.dependencies.updater.setFeedURL({ provider: "github", owner: UPDATE_OWNER, repo: UPDATE_REPOSITORY });
      await this.dependencies.updater.checkForUpdates();
      return this.currentStatus();
    } catch (error) {
      return this.setStatus({ phase: "error", message: desktopUpdateErrorMessage(error), progress: undefined });
    } finally {
      this.busy = false;
    }
  }

  async download() {
    if (this.busy) return this.currentStatus();
    if (this.status.phase !== "available") throw new Error("请先检查并确认有新版本。");
    this.busy = true;
    this.setStatus({ phase: "downloading", progress: 0, message: "正在下载新版。" });
    try {
      await this.dependencies.updater.downloadUpdate();
      return this.currentStatus();
    } catch (error) {
      return this.setStatus({ phase: "error", progress: undefined, message: desktopUpdateErrorMessage(error) });
    } finally {
      this.busy = false;
    }
  }

  async install() {
    if (this.status.phase !== "downloaded") throw new Error("新版尚未下载完成。");
    try {
      await this.dependencies.prepareInstall();
      this.dependencies.scheduleInstall(() => this.dependencies.updater.quitAndInstall(true, true));
    } catch (error) {
      this.setStatus({ phase: "error", progress: undefined, message: error instanceof Error ? error.message : "关闭后台服务失败，已取消安装。" });
      throw error;
    }
  }

  private initializeUpdater() {
    if (this.initialized) return;
    this.initialized = true;
    const updater = this.dependencies.updater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.logger = null;
    updater.fullChangelog = true;
    updater.on("update-available", (info) => {
      this.setStatus({ phase: "available", availableVersion: info.version, releaseNotes: normalizeReleaseNotes(info.releaseNotes, info.version), progress: undefined, message: `发现新版本 ${info.version}。` });
    });
    updater.on("update-not-available", (info) => {
      this.setStatus({ phase: "upToDate", availableVersion: undefined, releaseNotes: normalizeReleaseNotes(info.releaseNotes, info.version), progress: undefined, message: "当前已经是最新版本。" });
    });
    updater.on("download-progress", (info) => {
      const percent = Math.max(0, Math.min(100, Math.round(info.percent)));
      this.setStatus({ phase: "downloading", progress: percent, message: `正在下载 ${percent}%。` });
    });
    updater.on("update-downloaded", (info) => {
      this.setStatus({ phase: "downloaded", availableVersion: info.version, progress: 100, message: "新版已下载，等待你重启安装。" });
    });
    updater.on("error", (error) => {
      this.setStatus({ phase: "error", progress: undefined, message: desktopUpdateErrorMessage(error) });
    });
  }

}

function normalizeReleaseNotes(value: UpdateInfo["releaseNotes"], fallbackVersion: string): DesktopReleaseNote[] {
  const source = typeof value === "string"
    ? [{ version: fallbackVersion, note: value }]
    : Array.isArray(value)
      ? value.map((entry) => ({ version: typeof entry.version === "string" ? entry.version : fallbackVersion, note: typeof entry.note === "string" ? entry.note : "" }))
      : [];
  const result: DesktopReleaseNote[] = [];
  let totalBytes = 0;
  for (const entry of source.slice(0, MAX_RELEASE_NOTES)) {
    const version = entry.version.trim();
    if (!version) continue;
    const note = releaseNoteText(entry.note).slice(0, MAX_RELEASE_NOTE_LENGTH);
    const bytes = Buffer.byteLength(note, "utf8");
    if (totalBytes + bytes > MAX_RELEASE_NOTES_BYTES) break;
    totalBytes += bytes;
    result.push({ version, note });
  }
  return result;
}

function releaseNoteText(value: string) {
  return decodeHtmlEntities(value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:li|p|div|h[1-6]|ul|ol|blockquote|pre|section)>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.toLowerCase().startsWith("#x")) return decodeCodePoint(entity.slice(2), 16, match);
    if (entity.startsWith("#")) return decodeCodePoint(entity.slice(1), 10, match);
    return named[entity.toLowerCase()] || match;
  });
}

function decodeCodePoint(value: string, radix: number, fallback: string) {
  const point = Number.parseInt(value, radix);
  return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : fallback;
}
