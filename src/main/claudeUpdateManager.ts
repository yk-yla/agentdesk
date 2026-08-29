import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, promises as fsPromises, readFileSync } from "node:fs";
import path from "node:path";
import type { ClaudeRuntimeStatus } from "../shared/protocol";
import { CLI_VERSION_PATTERN, compareVersions } from "./version";
import { hasClaudeCredential, readClaudeCredentials } from "./providers/claude/claudeCredentials";
import { inspectAndExtractClaudeZip, inspectClaudeExecutable, managedClaudeExecutablePath, replaceClaudeExecutable } from "./providers/claude/claudeUpdater";
import { resolveExecutableFromPath } from "./executablePath";
import { cliExecutableExists, detectCliRuntime, hasCliProcess, readCliVersion, readWindowsProcesses, type CliRuntimeSnapshot } from "./cliRuntime";

const CLAUDE_RELEASE_API = "https://api.github.com/repos/anthropics/claude-code/releases/latest";
const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";
const MAX_CLAUDE_DOWNLOAD_BYTES = 300 * 1024 * 1024;
const CLAUDE_DOWNLOAD_HOSTS = new Set(["gh-proxy.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const CLAUDE_ASSET_NAME = "claude-win32-x64.zip";
const CLAUDE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CLAUDE_RETRY_MS = 30 * 60 * 1000;

export type ClaudeInstallSource = "npm" | "winget" | "managed" | "native" | "custom" | "unknown";
export type ClaudeDownloadSource = "official" | "proxy";

interface PendingClaudeUpdate {
  directory: string | null;
  executable: string;
  version: string;
  signatureValid: boolean;
  signer: string;
  signatureStatus: string;
  downloadSource: ClaudeDownloadSource;
  dryRun?: boolean;
}

interface ClaudeCredentialStatus {
  credentialsAvailable: boolean;
  credentialSource: ClaudeRuntimeStatus["credentialSource"];
  credentialMessage: string;
}

export interface ClaudeUpdateManagerDependencies {
  appPath(): string;
  userDataPath(): string;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  shutdownQueries(): Promise<void>;
  emitStatus(status: ClaudeRuntimeStatus): void;
  managedExecutablePath?: () => string;
  readSdkVersion?: () => string;
  readBinaryVersion?: (executable: string) => string;
  credentialStatus?: () => ClaudeCredentialStatus;
  proxyDownloadUrl?: (officialUrl: string, version: string) => string | null;
  processSupervisor?: { track<T extends import("node:child_process").ChildProcess>(child: T): T; terminate(child: import("node:child_process").ChildProcess): Promise<void> };
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  runtimeSnapshot?: () => CliRuntimeSnapshot;
  isCliInUse?: () => Promise<boolean>;
}

export function isTrustedClaudeDownloadUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && CLAUDE_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function officialClaudeDownloadUrl(version: string) {
  if (!CLI_VERSION_PATTERN.test(version)) throw new Error("Claude 下载版本无效。");
  return `https://github.com/anthropics/claude-code/releases/download/v${version}/${CLAUDE_ASSET_NAME}`;
}

export function latestClaudeDownloadUrl() {
  return `https://github.com/anthropics/claude-code/releases/latest/download/${CLAUDE_ASSET_NAME}`;
}

function defaultProxyDownloadUrl(officialUrl: string) {
  return `https://gh-proxy.com/${officialUrl}`;
}

async function fetchClaudeArchive(urlValue: string, target: string, fetcher: ClaudeUpdateManagerDependencies["fetch"]) {
  let url = new URL(urlValue);
  let response: Response | null = null;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!isTrustedClaudeDownloadUrl(url.toString())) throw new Error("下载地址或重定向目标不受信任。");
    response = await fetcher(url.toString(), { redirect: "manual", headers: { "User-Agent": "AgentDesk" } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw new Error("下载重定向缺少目标。");
    url = new URL(location, url);
    response = null;
  }
  if (!response?.ok || !response.body) throw new Error(`返回 ${response?.status || "无响应"}`);
  const file = await fsPromises.open(target, "wx");
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_CLAUDE_DOWNLOAD_BYTES) throw new Error("下载文件超过大小限制。");
      await file.write(Buffer.from(chunk.value));
    }
  } finally {
    await file.close();
  }
  if (!total) throw new Error("下载文件为空。");
}

export async function downloadClaudeArchive(input: {
  target: string;
  version: string;
  fetch: ClaudeUpdateManagerDependencies["fetch"];
  officialUrl?: string;
  proxyUrl?: string | null;
  proxyFirst?: boolean;
}): Promise<ClaudeDownloadSource> {
  const officialUrl = input.officialUrl || officialClaudeDownloadUrl(input.version);
  const officialSource = { source: "official" as const, url: officialUrl };
  const proxySource = input.proxyUrl ? { source: "proxy" as const, url: input.proxyUrl } : null;
  const sources: Array<{ source: ClaudeDownloadSource; url: string }> = input.proxyFirst && proxySource
    ? [proxySource, officialSource]
    : [officialSource, ...(proxySource ? [proxySource] : [])];
  const failures: string[] = [];
  for (const candidate of sources) {
    await fsPromises.rm(input.target, { force: true }).catch(() => undefined);
    try {
      await fetchClaudeArchive(candidate.url, input.target, input.fetch);
      return candidate.source;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "未知错误";
      failures.push(`${candidate.source === "official" ? "官方源" : "代理回退"}失败：${reason}`);
    }
  }
  await fsPromises.rm(input.target, { force: true }).catch(() => undefined);
  throw new Error(`Claude 下载失败（${failures.join("；")}）。`);
}

export class ClaudeUpdateManager {
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingUpdate: PendingClaudeUpdate | null = null;
  private detectedInstallSource: ClaudeInstallSource | null = null;
  private snapshot: CliRuntimeSnapshot | null = null;
  private status: ClaudeRuntimeStatus = {
    phase: "idle",
    binarySource: "sdk",
    binaryVersion: "",
    sdkVersion: "",
    credentialsAvailable: false,
    credentialSource: "unavailable",
    credentialMessage: "正在检查 Claude 配置。",
    message: "等待检查更新。",
  };

  constructor(private readonly dependencies: ClaudeUpdateManagerDependencies) {}

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  currentStatus() {
    const installSource = this.detectInstallSource();
    const managed = installSource === "managed";
    const binaryVersion = this.snapshot?.currentVersion || (managed ? this.readBinaryVersion(this.managedPath()) : this.readInstalledVersionSync());
    this.status = {
      ...this.status,
      ...this.readCredentialStatus(),
      binarySource: managed ? "managed" : installSource !== "unknown" ? "external" : "sdk",
      installSource,
      binaryVersion: binaryVersion || this.readSdkVersion(),
      sdkVersion: this.readSdkVersion(),
      ...(this.snapshot ? { executablePath: this.snapshot.executablePath, detectedAt: this.snapshot.detectedAt } : {}),
    };
    return { ...this.status };
  }

  setStatus(patch: Partial<ClaudeRuntimeStatus>) {
    this.status = { ...this.currentStatus(), ...patch };
    const status = this.currentStatus();
    this.dependencies.emitStatus(status);
    return status;
  }

  detectInstallSource(): ClaudeInstallSource {
    if (this.detectedInstallSource) return this.detectedInstallSource;
    if (!this.snapshot) {
      if (this.dependencies.managedExecutablePath && existsSync(this.dependencies.managedExecutablePath())) {
        const executablePath = this.dependencies.managedExecutablePath();
        this.snapshot = { provider: "claude", source: "managed", executablePath, currentVersion: this.readBinaryVersion(executablePath), detectedAt: Date.now(), updateStrategy: "self" };
      } else this.snapshot = this.dependencies.runtimeSnapshot?.() || detectCliRuntime("claude", this.environment());
    }
    if (this.snapshot.source === "missing") {
      this.detectedInstallSource = "unknown";
      return "unknown";
    }
    if (this.snapshot.source === "managed") {
      this.detectedInstallSource = "managed";
      return "managed";
    }
    if (this.snapshot.source === "native") { this.detectedInstallSource = "native"; return "native"; }
    if (this.snapshot.source === "winget") { this.detectedInstallSource = "winget"; return "winget"; }
    if (this.snapshot.source === "custom") { this.detectedInstallSource = "custom"; return "custom"; }
    if (this.snapshot.source === "npm") {
      this.detectedInstallSource = "npm";
      return "npm";
    }
    this.detectedInstallSource = "unknown";
    return "unknown";
  }

  async initialize() {
    if (this.dependencies.managedExecutablePath && existsSync(this.dependencies.managedExecutablePath())) {
      const executablePath = this.dependencies.managedExecutablePath();
      this.snapshot = { provider: "claude", source: "managed", executablePath, currentVersion: this.readBinaryVersion(executablePath), detectedAt: Date.now(), updateStrategy: "self" };
    } else this.snapshot = this.dependencies.runtimeSnapshot?.() || detectCliRuntime("claude", this.environment());
    this.detectedInstallSource = null;
    const status = this.currentStatus();
    if (status.installSource !== "unknown") void this.check();
    return status;
  }

  resetInstallSource() {
    this.detectedInstallSource = null;
  }

  private refreshSnapshotVersion(fallback = "") {
    if (!this.snapshot?.executablePath) return fallback;
    const currentVersion = readCliVersion(this.snapshot.executablePath, this.environment()) || fallback;
    this.snapshot = { ...this.snapshot, currentVersion };
    return currentVersion;
  }

  async check() {
    if (this.busy) return this.currentStatus();
    const current = this.currentStatus();
    const installSource = current.installSource || this.detectInstallSource();
    if (installSource === "unknown") return this.setStatus({ phase: "notInstalled", message: "未检测到 Claude Code，请先安装。" });
    this.busy = true;
    this.setStatus({ phase: "checking", message: "正在检查 Claude Code 新版本。" });
    try {
      const latestVersion = await this.fetchLatestVersion();
      const currentVersion = current.binaryVersion;
      const available = currentVersion ? compareVersions(latestVersion, currentVersion) > 0 : true;
      this.scheduleCheck(CLAUDE_CHECK_INTERVAL_MS);
      return this.setStatus({
        phase: available ? "available" : "upToDate",
        latestVersion,
        checkedAt: Date.now(),
        message: available ? `发现 Claude Code ${latestVersion}。` : "Claude Code 已是最新版本。",
      });
    } catch (error) {
      this.scheduleCheck(CLAUDE_RETRY_MS);
      return this.setStatus({ phase: "error", message: this.friendlyErrorMessage(error) });
    } finally {
      this.busy = false;
    }
  }

  async update(allowUnverified: boolean) {
    if (this.busy) return this.currentStatus();
    const current = this.currentStatus();
    const installSource = current.installSource || this.detectInstallSource();
    const version = current.latestVersion || "";
    if (installSource === "unknown") return this.setStatus({ phase: "notInstalled", message: "未检测到 Claude Code，请先安装。" });
    if (!CLI_VERSION_PATTERN.test(version)) return this.check();
    if (this.snapshot?.executablePath && !cliExecutableExists(this.snapshot.executablePath)) return this.setStatus({ phase: "error", message: "启动时记录的 Claude Code 文件已不存在，请重启 AgentDesk 使安装信息刷新。" });
    if (installSource === "custom") return this.setStatus({ phase: "error", message: "当前使用自定义 Claude Code 路径，请按该路径的安装来源手动更新。" });
    this.busy = true;
    try {
      if (await this.isCliInUse()) throw new Error("Claude Code 正在被会话使用，请先关闭相关会话后再更新。");
      if (installSource === "npm") return await this.updateViaNpm(version);
      if (installSource === "winget") return await this.updateViaWinget(version);
      if (installSource === "native") return await this.updateViaNative(version, allowUnverified);
      return await this.updateViaManaged(version, allowUnverified);
    } catch (error) {
      return this.setStatus({ phase: "error", message: this.friendlyErrorMessage(error) });
    } finally {
      this.busy = false;
    }
  }

  async setSignatureFixture(executable: string) {
    const inspection = await inspectClaudeExecutable(executable);
    const version = this.currentStatus().binaryVersion || "0.0.0";
    this.pendingUpdate = {
      directory: null,
      executable,
      version,
      signatureValid: inspection.signatureValid,
      signer: inspection.signer,
      signatureStatus: inspection.signatureStatus,
      downloadSource: "official",
      dryRun: true,
    };
    return this.setStatus({
      phase: "available",
      latestVersion: version,
      integrityVerified: inspection.signatureValid,
      integritySigner: inspection.signer || "未检测到签名者",
      integrityStatus: inspection.signatureStatus,
      message: inspection.signatureValid ? "C-09 官方签名样本已验证。" : `C-09 样本无法验证发布方完整性（签名者：${inspection.signer || "未检测到签名者"}）。`,
    });
  }

  private async updateViaNpm(version: string) {
    this.setStatus({ phase: "updating", message: `正在通过 npm 更新 Claude Code 到 ${version}。` });
    await this.dependencies.shutdownQueries();
    const platform = this.platform();
    const env = this.environment();
    const executable = platform === "win32" ? env.ComSpec || "cmd.exe" : "npm";
    const args = platform === "win32"
      ? ["/d", "/s", "/c", `npm.cmd install -g ${CLAUDE_NPM_PACKAGE}@${version}`]
      : ["install", "-g", `${CLAUDE_NPM_PACKAGE}@${version}`];
    await this.runExternalCommand(executable, args, 30 * 60_000);
    const installedVersion = this.refreshSnapshotVersion(await this.readInstalledVersionFromNpm());
    if (installedVersion !== version) throw new Error(`更新后版本 ${installedVersion || "未知"} 与预期 ${version} 不一致。`);
    this.resetInstallSource();
    return this.setStatus({ phase: "updated", binaryVersion: installedVersion || version, latestVersion: version, checkedAt: Date.now(), message: `Claude Code 已通过 npm 更新到 ${installedVersion || version}。` });
  }

  private async updateViaNative(version: string, allowUnverified: boolean) {
    const target = this.snapshot?.executablePath || resolveExecutableFromPath("claude.exe") || "claude.exe";
    return this.updateViaArchive(version, allowUnverified, target, "native");
  }

  private async isCliInUse() {
    if (this.dependencies.isCliInUse) return this.dependencies.isCliInUse();
    if (this.platform() !== "win32") return false;
    try {
      return hasCliProcess(await readWindowsProcesses({ environment: this.environment(), track: (child) => this.dependencies.processSupervisor?.track(child), terminate: async (child) => { await this.dependencies.processSupervisor?.terminate(child); } }), "claude");
    } catch {
      throw new Error("无法确认 Claude Code 是否正在使用，为避免中断会话，本次更新已取消。");
    }
  }

  private async updateViaWinget(version: string) {
    this.setStatus({ phase: "updating", message: `正在通过 winget 更新 Claude Code 到 ${version}。` });
    await this.dependencies.shutdownQueries();
    await this.runExternalCommand("winget.exe", ["upgrade", "Anthropic.ClaudeCode", "--silent", "--accept-source-agreements"], 10 * 60_000);
    this.resetInstallSource();
    const installedVersion = this.refreshSnapshotVersion();
    if (installedVersion !== version) throw new Error(`更新后版本 ${installedVersion || "未知"} 与预期 ${version} 不一致。`);
    return this.setStatus({ phase: "updated", binaryVersion: installedVersion, latestVersion: version, checkedAt: Date.now(), message: `Claude Code 已通过 winget 更新到 ${installedVersion}。` });
  }

  private async updateViaManaged(version: string, allowUnverified: boolean) {
    return this.updateViaArchive(version, allowUnverified, this.managedPath(), "managed");
  }

  private async updateViaArchive(version: string, allowUnverified: boolean, targetPath: string, mode: "managed" | "native") {
    let updateDirectory: string | null = null;
    try {
      if (!this.pendingUpdate || this.pendingUpdate.version !== version) {
        await this.cleanupUpdateRoot(this.pendingUpdate?.directory || undefined);
        if (this.pendingUpdate?.directory) await fsPromises.rm(this.pendingUpdate.directory, { recursive: true, force: true });
        const directory = path.join(this.dependencies.userDataPath(), "claude-update", randomUUID());
        updateDirectory = directory;
        await fsPromises.mkdir(directory, { recursive: true });
        const zipPath = path.join(directory, "claude.zip");
        const executable = path.join(directory, "claude.exe");
        this.setStatus({ phase: "updating", message: mode === "native" ? `正在通过 gh-proxy 下载 Claude Code ${version}。` : `正在下载 Claude Code ${version}。` });
        const officialUrl = mode === "native" ? latestClaudeDownloadUrl() : officialClaudeDownloadUrl(version);
        const configuredProxy = this.dependencies.proxyDownloadUrl
          ? this.dependencies.proxyDownloadUrl(officialUrl, version)
          : defaultProxyDownloadUrl(officialUrl);
        const downloadSource = await downloadClaudeArchive({
          target: zipPath,
          version,
          fetch: this.dependencies.fetch,
          officialUrl,
          proxyUrl: configuredProxy,
          ...(mode === "native" ? { proxyFirst: true } : {}),
        });
        this.setStatus({ phase: "updating", message: downloadSource === "proxy" ? "已通过 gh-proxy 下载，正在验证完整性和签名。" : "Claude 官方下载完成，正在验证完整性和签名。" });
        const inspection = await inspectAndExtractClaudeZip(zipPath, executable);
        // 解压和签名检查完成后不再需要压缩包，避免在二次确认或异常退出时留下大文件。
        await fsPromises.rm(zipPath, { force: true });
        this.pendingUpdate = { directory, executable, version, signatureValid: inspection.signatureValid, signer: inspection.signer, signatureStatus: inspection.signatureStatus, downloadSource };
      }
      if (!this.pendingUpdate.signatureValid && !allowUnverified) {
        const signer = this.pendingUpdate.signer || "未检测到签名者";
        return this.setStatus({ phase: "available", integrityVerified: false, integritySigner: signer, integrityStatus: this.pendingUpdate.signatureStatus, message: `无法验证发布方完整性（签名者：${signer}），需要再次确认后才能安装。` });
      }
      if (this.pendingUpdate.dryRun) {
        const verified = this.pendingUpdate.signatureValid;
        await this.dependencies.shutdownQueries();
        this.pendingUpdate = null;
        return this.setStatus({ phase: "updated", integrityVerified: verified, message: verified ? "C-09 官方签名样本验证通过，未执行安装。" : "C-09 未验证签名样本已完成二次确认，未执行安装。" });
      }
      this.setStatus({ phase: "updating", integrityVerified: this.pendingUpdate.signatureValid, integritySigner: this.pendingUpdate.signer, integrityStatus: this.pendingUpdate.signatureStatus, message: mode === "native" ? "正在停止 Claude 会话并替换 Claude Code。" : "正在停止 Claude 会话并替换受管二进制。" });
      await this.dependencies.shutdownQueries();
      const installed = await replaceClaudeExecutable(this.pendingUpdate.executable, targetPath, async () => {
        const installedVersion = this.readBinaryVersion(targetPath);
        if (installedVersion !== version) throw new Error(`更新后版本 ${installedVersion || "未知"} 与预期 ${version} 不一致。`);
        return installedVersion;
      });
      const downloadSource = this.pendingUpdate.downloadSource;
      if (this.pendingUpdate.directory) await fsPromises.rm(this.pendingUpdate.directory, { recursive: true, force: true });
      this.pendingUpdate = null;
      this.resetInstallSource();
      if (this.snapshot) this.snapshot = { ...this.snapshot, currentVersion: installed.version };
      return this.setStatus({ phase: "updated", binaryVersion: installed.version, latestVersion: installed.version, checkedAt: Date.now(), message: `Claude Code 已更新到 ${installed.version}${downloadSource === "proxy" ? "（代理回退，gh-proxy）" : "（GitHub 官方源）"}。` });
    } catch (error) {
      const failedDirectory = this.pendingUpdate?.directory || updateDirectory;
      if (failedDirectory) await fsPromises.rm(failedDirectory, { recursive: true, force: true }).catch(() => undefined);
      this.pendingUpdate = null;
      throw error;
    }
  }

  private scheduleCheck(delayMs: number) {
    void delayMs;
    this.dispose();
    this.setStatus({ nextCheckAt: undefined });
  }

  private async fetchLatestVersion() {
    const response = await this.dependencies.fetch(CLAUDE_RELEASE_API, { headers: { Accept: "application/vnd.github+json", "User-Agent": "AgentDesk" } });
    if (!response.ok) throw new Error(`Claude 发布源返回 ${response.status}。`);
    const value = await response.json() as { tag_name?: unknown };
    const latestVersion = typeof value.tag_name === "string" ? value.tag_name.replace(/^v/i, "") : "";
    if (!CLI_VERSION_PATTERN.test(latestVersion)) throw new Error("Claude 发布源没有返回有效版本。");
    return latestVersion;
  }

  private runExternalCommand(executable: string, args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      if (this.dependencies.processSupervisor) this.dependencies.processSupervisor.track(child);
      let settled = false;
      let errorTail = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => { errorTail = `${errorTail}${chunk}`.slice(-32 * 1024); });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error("Claude Code 更新超时。"));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(errorTail.trim() || `Claude Code 更新进程退出，代码 ${code ?? "未知"}。`));
      });
    });
  }

  private async readInstalledVersionFromNpm(): Promise<string> {
    const platform = this.platform();
    const env = this.environment();
    const executable = platform === "win32" ? env.ComSpec || "cmd.exe" : "npm";
    const args = platform === "win32"
      ? ["/d", "/s", "/c", `npm.cmd list -g ${CLAUDE_NPM_PACKAGE} --depth=0 --json`]
      : ["list", "-g", CLAUDE_NPM_PACKAGE, "--depth=0", "--json"];
    return new Promise((resolve) => {
      const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { output = `${output}${chunk}`.slice(-256 * 1024); });
      const timer = setTimeout(() => { child.kill(); resolve(""); }, 30_000);
      if (timer.unref) timer.unref();
      child.once("error", () => { clearTimeout(timer); resolve(""); });
      child.once("exit", () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(output.trim()) as { dependencies?: Record<string, { version?: string }> };
          resolve(parsed.dependencies?.[CLAUDE_NPM_PACKAGE]?.version || "");
        } catch { resolve(""); }
      });
    });
  }

  private readInstalledVersionSync(): string {
    const executable = this.snapshot?.executablePath || resolveExecutableFromPath(this.platform() === "win32" ? "claude.cmd" : "claude")
      || resolveExecutableFromPath("claude.exe") || "";
    if (!executable) return "";
    return this.readBinaryVersion(executable);
  }

  private friendlyErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error || "");
    if (/net::|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|socket|fetch failed/i.test(message)) {
      const installSource = this.detectInstallSource();
      if (installSource === "managed") return "无法连接 GitHub（需要外网环境），请确认网络可以访问 github.com 后重试，或联系 IT 同事协助。";
      if (installSource === "npm") return "无法连接 npm 源，请检查 npm 镜像配置或网络连接。";
      if (installSource === "winget") return "无法连接 winget 源，请检查网络连接。";
      return "网络连接失败，请检查网络后重试。";
    }
    if (/401|403|unauthorized|forbidden|rate limit/i.test(message)) return "更新服务器暂时拒绝请求（可能是访问频率限制），请稍后重试。";
    if (/404|not found/i.test(message)) return "未找到可用的更新版本。";
    if (/timed out|timeout|超时/i.test(message)) return "更新操作超时，请检查网络后重试。";
    return message || "Claude Code 更新失败，请稍后重试。";
  }

  private platform() {
    return this.dependencies.platform || process.platform;
  }

  private environment() {
    return this.dependencies.environment || process.env;
  }

  private managedPath() {
    return this.snapshot?.executablePath || this.dependencies.managedExecutablePath?.() || managedClaudeExecutablePath();
  }

  private readSdkVersion() {
    if (this.dependencies.readSdkVersion) return this.dependencies.readSdkVersion();
    try {
      const value = JSON.parse(readFileSync(path.join(this.dependencies.appPath(), "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8")) as { version?: unknown };
      return typeof value.version === "string" ? value.version : "";
    } catch {
      return "";
    }
  }

  private readBinaryVersion(executable: string) {
    if (this.dependencies.readBinaryVersion) return this.dependencies.readBinaryVersion(executable);
    if (!existsSync(executable)) return "";
    const result = spawnSync(executable, ["--version"], { windowsHide: true, shell: false, encoding: "utf8", timeout: 10_000 });
    const output = `${typeof result.stdout === "string" ? result.stdout : ""}\n${typeof result.stderr === "string" ? result.stderr : ""}`;
    return output.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0] || "";
  }

  private readCredentialStatus(): ClaudeCredentialStatus {
    if (this.dependencies.credentialStatus) return this.dependencies.credentialStatus();
    try {
      const credential = readClaudeCredentials();
      const available = hasClaudeCredential(credential);
      return {
        credentialsAvailable: available,
        credentialSource: credential.source,
        credentialMessage: credential.source === "native"
          ? "使用 Claude Code 原生登录状态。"
          : available ? `凭据可用，来源：${credential.source === "settings" ? "全局 settings.json" : "进程环境"}。` : "未检测到 Claude 认证字段。",
      };
    } catch (error) {
      return {
        credentialsAvailable: false,
        credentialSource: "unavailable",
        credentialMessage: error instanceof Error ? error.message : "Claude 配置无法读取。",
      };
    }
  }

  private async cleanupUpdateRoot(keepDirectory?: string) {
    const root = path.join(this.dependencies.userDataPath(), "claude-update");
    const entries = await fsPromises.readdir(root, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && path.join(root, entry.name) !== keepDirectory)
      .map((entry) => fsPromises.rm(path.join(root, entry.name), { recursive: true, force: true })));
  }
}
