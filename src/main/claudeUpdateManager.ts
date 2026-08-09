import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, promises as fsPromises, readFileSync } from "node:fs";
import path from "node:path";
import type { ClaudeRuntimeStatus } from "../shared/protocol";
import { CLI_VERSION_PATTERN, compareVersions } from "./version";
import { hasClaudeCredential, readClaudeCredentials } from "./providers/claude/claudeCredentials";
import { inspectAndExtractClaudeZip, inspectClaudeExecutable, managedClaudeExecutablePath, replaceClaudeExecutable } from "./providers/claude/claudeUpdater";
import { trustedWorkspaces } from "./providers/claude/claudeWorkspaceTrust";

const CLAUDE_RELEASE_API = "https://api.github.com/repos/anthropics/claude-code/releases/latest";
const MAX_CLAUDE_DOWNLOAD_BYTES = 300 * 1024 * 1024;
const CLAUDE_DOWNLOAD_HOSTS = new Set(["gh-proxy.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const CLAUDE_ASSET_NAME = "claude-win32-x64.zip";

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

export type ClaudeDownloadSource = "official" | "proxy";

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
  trustedWorkspaces?: () => string[];
  proxyDownloadUrl?: (officialUrl: string, version: string) => string | null;
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
  proxyUrl?: string | null;
}): Promise<ClaudeDownloadSource> {
  const officialUrl = officialClaudeDownloadUrl(input.version);
  const sources: Array<{ source: ClaudeDownloadSource; url: string }> = [{ source: "official", url: officialUrl }];
  if (input.proxyUrl) sources.push({ source: "proxy", url: input.proxyUrl });
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
  private pendingUpdate: PendingClaudeUpdate | null = null;
  private status: ClaudeRuntimeStatus = {
    phase: "idle",
    binarySource: "sdk",
    binaryVersion: "",
    sdkVersion: "",
    credentialsAvailable: false,
    credentialSource: "unavailable",
    credentialMessage: "正在检查 Claude 配置。",
    trustedWorkspaces: [],
    message: "仅在手动检查时连接 Claude Code 发布源。",
  };

  constructor(private readonly dependencies: ClaudeUpdateManagerDependencies) {}

  currentStatus() {
    const managed = existsSync(this.managedPath());
    this.status = {
      ...this.status,
      ...this.readCredentialStatus(),
      binarySource: managed ? "managed" : "sdk",
      binaryVersion: managed ? this.readBinaryVersion(this.managedPath()) : this.readSdkVersion(),
      sdkVersion: this.readSdkVersion(),
      trustedWorkspaces: this.readTrustedWorkspaces(),
    };
    return { ...this.status, trustedWorkspaces: [...this.status.trustedWorkspaces] };
  }

  setStatus(patch: Partial<ClaudeRuntimeStatus>) {
    this.status = { ...this.currentStatus(), ...patch };
    const status = this.currentStatus();
    this.dependencies.emitStatus(status);
    return status;
  }

  async check() {
    if (this.busy) return this.currentStatus();
    const current = this.currentStatus();
    if (current.binarySource !== "managed") return this.setStatus({ phase: "notInstalled", message: "当前使用 Agent SDK 随包二进制，受管更新不可用。" });
    this.busy = true;
    this.setStatus({ phase: "checking", message: "正在检查 Claude Code 新版本。" });
    try {
      const response = await this.dependencies.fetch(CLAUDE_RELEASE_API, { headers: { Accept: "application/vnd.github+json", "User-Agent": "AgentDesk" } });
      if (!response.ok) throw new Error(`Claude 发布源返回 ${response.status}。`);
      const value = await response.json() as { tag_name?: unknown };
      const latestVersion = typeof value.tag_name === "string" ? value.tag_name.replace(/^v/i, "") : "";
      if (!CLI_VERSION_PATTERN.test(latestVersion)) throw new Error("Claude 发布源没有返回有效版本。");
      const available = compareVersions(latestVersion, current.binaryVersion) > 0;
      return this.setStatus({
        phase: available ? "available" : "upToDate",
        latestVersion,
        checkedAt: Date.now(),
        message: available ? `发现 Claude Code ${latestVersion}。` : "Claude Code 已是最新版本。",
      });
    } catch (error) {
      return this.setStatus({ phase: "error", message: error instanceof Error ? error.message : "Claude Code 版本检查失败。" });
    } finally {
      this.busy = false;
    }
  }

  async update(allowUnverified: boolean) {
    if (this.busy) return this.currentStatus();
    const current = this.currentStatus();
    const version = current.latestVersion || "";
    if (current.binarySource !== "managed") return this.setStatus({ phase: "notInstalled", message: "当前使用 Agent SDK 随包二进制，不能执行受管更新。" });
    if (!CLI_VERSION_PATTERN.test(version)) return this.check();
    this.busy = true;
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
        this.setStatus({ phase: "updating", message: `正在下载 Claude Code ${version}。` });
        const officialUrl = officialClaudeDownloadUrl(version);
        const configuredProxy = this.dependencies.proxyDownloadUrl
          ? this.dependencies.proxyDownloadUrl(officialUrl, version)
          : defaultProxyDownloadUrl(officialUrl);
        const downloadSource = await downloadClaudeArchive({ target: zipPath, version, fetch: this.dependencies.fetch, proxyUrl: configuredProxy });
        this.setStatus({ phase: "updating", message: downloadSource === "proxy" ? "Claude 官方源不可用，已通过代理回退下载，正在验证完整性和签名。" : "Claude 官方下载完成，正在验证完整性和签名。" });
        const inspection = await inspectAndExtractClaudeZip(zipPath, executable);
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
      this.setStatus({ phase: "updating", integrityVerified: this.pendingUpdate.signatureValid, integritySigner: this.pendingUpdate.signer, integrityStatus: this.pendingUpdate.signatureStatus, message: "正在停止 Claude 会话并替换受管二进制。" });
      await this.dependencies.shutdownQueries();
      const target = this.managedPath();
      const installed = await replaceClaudeExecutable(this.pendingUpdate.executable, target, async () => {
        const installedVersion = this.readBinaryVersion(target);
        if (installedVersion !== version) throw new Error(`更新后版本 ${installedVersion || "未知"} 与预期 ${version} 不一致。`);
        return installedVersion;
      });
      const downloadSource = this.pendingUpdate.downloadSource;
      if (this.pendingUpdate.directory) await fsPromises.rm(this.pendingUpdate.directory, { recursive: true, force: true });
      this.pendingUpdate = null;
      return this.setStatus({ phase: "updated", binaryVersion: installed.version, latestVersion: installed.version, checkedAt: Date.now(), message: `Claude Code 已更新到 ${installed.version}${downloadSource === "proxy" ? "（代理回退）" : "（GitHub 官方源）"}。` });
    } catch (error) {
      const failedDirectory = this.pendingUpdate?.directory || updateDirectory;
      if (failedDirectory) await fsPromises.rm(failedDirectory, { recursive: true, force: true }).catch(() => undefined);
      this.pendingUpdate = null;
      return this.setStatus({ phase: "error", message: error instanceof Error ? error.message : "Claude Code 更新失败，旧版本已恢复。" });
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

  private managedPath() {
    return this.dependencies.managedExecutablePath?.() || managedClaudeExecutablePath();
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
        credentialMessage: available ? `凭据可用，来源：${credential.source === "settings" ? "全局 settings.json" : "受控进程环境"}。` : "未检测到 Claude 认证字段。",
      };
    } catch (error) {
      return {
        credentialsAvailable: false,
        credentialSource: "unavailable",
        credentialMessage: error instanceof Error ? error.message : "Claude 配置无法读取。",
      };
    }
  }

  private readTrustedWorkspaces() {
    return this.dependencies.trustedWorkspaces?.() || trustedWorkspaces();
  }

  private async cleanupUpdateRoot(keepDirectory?: string) {
    const root = path.join(this.dependencies.userDataPath(), "claude-update");
    const entries = await fsPromises.readdir(root, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && path.join(root, entry.name) !== keepDirectory)
      .map((entry) => fsPromises.rm(path.join(root, entry.name), { recursive: true, force: true })));
  }
}
