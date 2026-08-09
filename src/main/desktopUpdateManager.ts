import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { DesktopUpdateStatus } from "../shared/protocol";
import { writeTextFileAtomic } from "./atomicFile";

const UPDATE_OWNER = "yxb715";
const UPDATE_REPOSITORY = "agentdesk";
const UPDATE_REPOSITORY_URL = `https://github.com/${UPDATE_OWNER}/${UPDATE_REPOSITORY}`;

interface DesktopUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  logger: unknown;
  on(event: "update-available", listener: (info: { version: string }) => void): unknown;
  on(event: "update-not-available", listener: () => void): unknown;
  on(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  setFeedURL(options: { provider: "github"; owner: string; repo: string; private: true; token: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}

interface SecureTokenStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface DesktopUpdateManagerDependencies {
  updater: DesktopUpdater;
  storage: SecureTokenStorage;
  currentVersion(): string;
  isPackaged(): boolean;
  userDataPath(): string;
  emitStatus(status: DesktopUpdateStatus): void;
  prepareInstall(): Promise<void>;
  scheduleInstall(run: () => void): void;
  environment?: NodeJS.ProcessEnv;
}

export function desktopUpdateErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/404|not found|no published versions|latest version/i.test(message)) return "GitHub 还没有可用的正式版本，请先发布一个版本。";
  if (/401|403|unauthorized|forbidden|bad credentials|token/i.test(message)) return "GitHub 授权失败，请更新授权码。";
  if (/net::|network|fetch|socket|timeout|timed out/i.test(message)) return "无法连接 GitHub，请检查网络后重试。";
  return "更新操作失败，请稍后重试。";
}

export class DesktopUpdateManager {
  private initialized = false;
  private busy = false;
  private status: DesktopUpdateStatus = {
    phase: "idle",
    currentVersion: "",
    message: "仅在手动检查时连接私有 GitHub Release。",
    repositoryUrl: UPDATE_REPOSITORY_URL,
    tokenConfigured: false,
  };

  constructor(private readonly dependencies: DesktopUpdateManagerDependencies) {}

  currentStatus() {
    this.status = {
      ...this.status,
      currentVersion: this.dependencies.currentVersion(),
      tokenConfigured: Boolean(this.readToken()),
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

  saveToken(token: string) {
    const value = token.trim();
    if (value.length < 20 || value.length > 512) throw new Error("GitHub 授权码格式不正确。");
    if (!this.dependencies.storage.isEncryptionAvailable()) throw new Error("当前系统无法安全保存 GitHub 授权码。");
    const filePath = this.authPath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeTextFileAtomic(filePath, JSON.stringify({ encryptedToken: this.dependencies.storage.encryptString(value).toString("base64") }));
    return this.setStatus({ phase: "idle", message: "GitHub 授权已保存。", tokenConfigured: true, availableVersion: undefined, progress: undefined });
  }

  clearToken() {
    const filePath = this.authPath();
    if (existsSync(filePath)) unlinkSync(filePath);
    return this.setStatus({ phase: "authorizationRequired", message: "私有仓库需要 GitHub 授权码。", tokenConfigured: false, availableVersion: undefined, progress: undefined });
  }

  async check() {
    if (!this.dependencies.isPackaged()) return this.setStatus({ phase: "unsupported", message: "开发环境不检查软件更新。", progress: undefined });
    const token = this.readToken();
    if (!token) return this.setStatus({ phase: "authorizationRequired", tokenConfigured: false, message: "私有仓库需要 GitHub 授权码。", progress: undefined });
    if (this.busy) return this.currentStatus();
    this.initialize();
    this.busy = true;
    this.setStatus({ phase: "checking", tokenConfigured: true, message: "正在检查新版本。", progress: undefined });
    try {
      this.dependencies.updater.setFeedURL({ provider: "github", owner: UPDATE_OWNER, repo: UPDATE_REPOSITORY, private: true, token });
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

  private authPath() {
    return path.join(this.dependencies.userDataPath(), "update-auth.json");
  }

  private readToken() {
    const environment = this.dependencies.environment || process.env;
    const environmentToken = (environment.CODEX_DESKTOP_GH_TOKEN || environment.GH_TOKEN || "").trim();
    if (environmentToken) return environmentToken;
    try {
      if (!this.dependencies.storage.isEncryptionAvailable()) return "";
      const parsed = JSON.parse(readFileSync(this.authPath(), "utf8")) as { encryptedToken?: unknown };
      if (typeof parsed.encryptedToken !== "string" || !parsed.encryptedToken) return "";
      return this.dependencies.storage.decryptString(Buffer.from(parsed.encryptedToken, "base64")).trim();
    } catch {
      return "";
    }
  }

  private initialize() {
    if (this.initialized) return;
    this.initialized = true;
    const updater = this.dependencies.updater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.logger = null;
    updater.on("update-available", (info) => {
      this.setStatus({ phase: "available", availableVersion: info.version, progress: undefined, message: `发现新版本 ${info.version}。` });
    });
    updater.on("update-not-available", () => {
      this.setStatus({ phase: "upToDate", availableVersion: undefined, progress: undefined, message: "当前已经是最新版本。" });
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
