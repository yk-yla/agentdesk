import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CodexCliUpdateStatus } from "../shared/protocol";
import { SingleFlight } from "./asyncOperation";
import { writeTextFileAtomicAsync } from "./atomicFile";
import { ProcessSupervisor } from "./processSupervisor";
import { CLI_VERSION_PATTERN, compareVersions } from "./version";
import { cliExecutableExists, detectCliRuntime, hasCliProcess, readCliVersion, readWindowsProcesses, type CliRuntimeSnapshot } from "./cliRuntime";

export { compareVersions } from "./version";

const CODEX_CLI_PACKAGE = "@openai/codex";
const CLI_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CLI_RETRY_MS = 30 * 60 * 1000;
const CLI_NPM_UPDATE_TIMEOUT_MS = 30 * 60 * 1000;

interface CodexCliUpdateCache {
  schema: 2;
  source: string;
  executablePath: string;
  latestVersion: string;
  checkedAt: number;
}

interface CodexAppServerControl {
  readonly isRunning: boolean;
  close(): Promise<void>;
  ensureStarted(options?: { allowBlocked?: boolean }): Promise<void>;
}

interface CodexCliUpdateOperations {
  readInstalledVersion(): Promise<string>;
  readLatestVersion(): Promise<string>;
  installVersion(version: string): Promise<void>;
}

export interface CodexCliUpdateManagerDependencies {
  processSupervisor: ProcessSupervisor;
  appServer: CodexAppServerControl;
  /** Other AgentDesk-owned app-server instances, such as the read-only history runtime. */
  additionalAppServers?: readonly CodexAppServerControl[];
  userDataPath(): string;
  isQuitting(): boolean;
  emitStatus(status: CodexCliUpdateStatus): void;
  notify(title: string, body: string): void;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  operations?: Partial<CodexCliUpdateOperations>;
  runtimeSnapshot?: () => CliRuntimeSnapshot;
  isCliInUse?: () => Promise<boolean>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export class CodexCliUpdateManager {
  private timer: NodeJS.Timeout | null = null;
  private checkPromise: Promise<CodexCliUpdateStatus> | null = null;
  private suppressExitNotification = false;
  private readonly updateFlight = new SingleFlight<CodexCliUpdateStatus>();
  private status: CodexCliUpdateStatus = {
    phase: "idle",
    currentVersion: "",
    message: "正在读取 Codex CLI 版本。",
  };
  private snapshot: CliRuntimeSnapshot | null = null;

  constructor(private readonly dependencies: CodexCliUpdateManagerDependencies) {}

  get active() {
    return this.updateFlight.active;
  }

  get exitNotificationSuppressed() {
    return this.suppressExitNotification;
  }

  currentStatus() {
    return { ...this.status };
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async initialize() {
    this.snapshot = this.dependencies.runtimeSnapshot?.() || detectCliRuntime("codex", this.environment());
    const currentVersion = await this.readInstalledVersion();
    const cache = this.readCache();
    if (!currentVersion) {
      this.setStatus({ phase: "notInstalled", currentVersion: "", latestVersion: cache?.latestVersion, checkedAt: cache?.checkedAt, message: "未检测到全局安装的 Codex CLI。" });
      this.scheduleCheck(CLI_CHECK_INTERVAL_MS);
      return;
    }
    if (cache && Date.now() - cache.checkedAt < CLI_CHECK_INTERVAL_MS) {
      this.setStatus({
        phase: compareVersions(cache.latestVersion, currentVersion) > 0 ? "available" : "upToDate",
        currentVersion,
        latestVersion: cache.latestVersion,
        checkedAt: cache.checkedAt,
        message: compareVersions(cache.latestVersion, currentVersion) > 0 ? `发现新版本 ${cache.latestVersion}，可立即更新。` : "当前已经是最新版本。",
      });
      this.scheduleCheck(CLI_CHECK_INTERVAL_MS - (Date.now() - cache.checkedAt));
      return;
    }
    this.setStatus({ phase: "idle", currentVersion, latestVersion: cache?.latestVersion, checkedAt: cache?.checkedAt, message: "正在检查 Codex CLI 新版本。" });
    void this.check(false);
  }

  async check(manual: boolean, retrying = false): Promise<CodexCliUpdateStatus> {
    if (this.updateFlight.current) return this.updateFlight.current;
    if (this.checkPromise) return this.checkPromise;
    this.dispose();
    this.checkPromise = Promise.resolve().then(async () => {
      const currentVersion = await this.readInstalledVersion();
      this.setStatus({ phase: "checking", currentVersion, message: manual ? "正在刷新 Codex CLI 版本。" : "正在检查 Codex CLI 新版本。" });
      if (!currentVersion) {
        this.scheduleCheck(CLI_CHECK_INTERVAL_MS);
        return this.setStatus({ phase: "notInstalled", latestVersion: undefined, checkedAt: undefined, message: "未检测到全局安装的 Codex CLI。" });
      }
      try {
        const latestVersion = await this.readLatestVersion();
        const checkedAt = Date.now();
        await this.writeCache({ latestVersion, checkedAt });
        this.scheduleCheck(CLI_CHECK_INTERVAL_MS);
        return this.setStatus({
          phase: compareVersions(latestVersion, currentVersion) > 0 ? "available" : "upToDate",
          currentVersion,
          latestVersion,
          checkedAt,
          message: compareVersions(latestVersion, currentVersion) > 0 ? `发现新版本 ${latestVersion}，可立即更新。` : "当前已经是最新版本。",
        });
      } catch {
        if (retrying) {
          this.scheduleCheck(CLI_CHECK_INTERVAL_MS);
          return this.setStatus({ phase: "error", currentVersion, message: "重试失败，请检查网络后手动重试。" });
        }
        this.scheduleCheck(CLI_RETRY_MS, true);
        const sourceName = this.snapshot?.updateStrategy === "self" ? "GitHub（需要外网环境）" : "npm 仓库";
        return this.setStatus({ phase: "error", currentVersion, message: `无法连接 ${sourceName}，请检查网络后手动重试。` });
      }
    }).finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  update(): Promise<CodexCliUpdateStatus> {
    return this.updateFlight.run(async () => {
      const latestVersion = this.status.latestVersion?.trim() || "";
      let currentVersion = this.status.currentVersion;
      let shouldRestartLocalAppServer = false;
      const restoreLocalAppServer = async () => {
        this.suppressExitNotification = false;
        if (!shouldRestartLocalAppServer || this.dependencies.isQuitting()) return "";
        try {
          await this.dependencies.appServer.ensureStarted({ allowBlocked: true });
          return "";
        } catch {
          return "桌面端 Codex 服务恢复失败，请重新发送消息后重试。";
        }
      };
      try {
        if (this.dependencies.isQuitting()) return this.currentStatus();
        if (this.snapshot?.source === "custom") throw new Error("当前使用自定义 Codex CLI，请按自定义来源更新。");
        currentVersion = await this.readInstalledVersion();
        if (this.dependencies.isQuitting()) return this.currentStatus();
        if (!currentVersion) return this.setStatus({ phase: "notInstalled", currentVersion: "", message: "未检测到全局安装的 Codex CLI。" });
        if (this.snapshot?.executablePath && !cliExecutableExists(this.snapshot.executablePath)) throw new Error("启动时记录的 Codex CLI 文件已不存在，请重启 AgentDesk 使安装信息刷新。");
        if (this.snapshot?.source === "missing") return this.setStatus({ phase: "notInstalled", currentVersion: "", message: "未检测到 Codex CLI，请重启 AgentDesk 后重试。" });
        if (!latestVersion || !CLI_VERSION_PATTERN.test(latestVersion) || compareVersions(latestVersion, currentVersion) <= 0) {
          return this.setStatus({ phase: "upToDate", currentVersion, latestVersion: latestVersion || currentVersion, checkedAt: Date.now(), message: "当前已经是最新版本。" });
        }
        this.dispose();
        if (await this.isCliInUse()) throw new Error("Codex CLI 正在被会话使用，请先关闭相关会话后再更新。");
        shouldRestartLocalAppServer = this.dependencies.appServer.isRunning;
        this.suppressExitNotification = shouldRestartLocalAppServer;
        this.setStatus({ phase: "updating", currentVersion, latestVersion, message: "正在停止所有 Codex app-server。", nextCheckAt: undefined });
        await this.prepareAppServerUpdate();
        if (await this.isCliInUse()) throw new Error("Codex CLI 正在被会话使用，请先关闭相关会话后再更新。");
        if (this.dependencies.isQuitting()) return this.currentStatus();
        this.setStatus({ phase: "updating", currentVersion, latestVersion, message: `正在更新 Codex CLI 到 ${latestVersion}。`, nextCheckAt: undefined });
        await this.installVersion(latestVersion);
        if (this.dependencies.isQuitting()) return this.currentStatus();
        const installedVersion = await this.refreshInstalledVersion();
        if (installedVersion !== latestVersion) throw new Error(`更新后检测到版本 ${installedVersion || "未知"}，不是 ${latestVersion}。`);
        const restartError = await restoreLocalAppServer();
        const checkedAt = Date.now();
        await this.writeCache({ latestVersion: installedVersion, checkedAt });
        if (!this.dependencies.isQuitting()) this.scheduleCheck(CLI_CHECK_INTERVAL_MS);
        const message = restartError
          ? `已更新到 ${installedVersion}，但${restartError}`
          : `已更新到 ${installedVersion}，桌面端 Codex 服务已恢复。`;
        if (!this.dependencies.isQuitting()) this.dependencies.notify("Codex CLI 已更新", message);
        return this.setStatus({ phase: "upToDate", currentVersion: installedVersion, latestVersion: installedVersion, checkedAt, message });
      } catch (error) {
        if (this.dependencies.isQuitting()) return this.currentStatus();
        const restartError = await restoreLocalAppServer();
        this.scheduleCheck(CLI_RETRY_MS);
        const message = `${this.errorMessage(error)}${restartError ? ` ${restartError}` : ""}`;
        this.dependencies.notify("Codex CLI 更新失败", message);
        return this.setStatus({ phase: "error", currentVersion: await this.readInstalledVersion() || currentVersion, latestVersion, message });
      } finally {
        this.suppressExitNotification = false;
      }
    });
  }

  private environment() {
    return this.dependencies.environment || process.env;
  }

  private platform() {
    return this.dependencies.platform || process.platform;
  }

  private setStatus(patch: Partial<CodexCliUpdateStatus>) {
    const installSource = this.snapshot?.source === "npm" || this.snapshot?.source === "native" || this.snapshot?.source === "custom" ? this.snapshot.source : "missing";
    this.status = { ...this.status, ...patch, ...(this.snapshot ? { installSource, executablePath: this.snapshot.executablePath, detectedAt: this.snapshot.detectedAt } : {}) };
    const status = this.currentStatus();
    this.dependencies.emitStatus(status);
    return status;
  }

  private scheduleCheck(delayMs: number, retrying = false) {
    // 安装来源和程序路径只在启动时快照；运行期间不再后台扫描或切换。
    // 保留该方法以兼容旧缓存/调用路径，但不创建定时器。
    void delayMs;
    void retrying;
    this.dispose();
    this.setStatus({ nextCheckAt: undefined });
  }

  private cachePath() {
    return path.join(this.dependencies.userDataPath(), "codex-cli-update-cache.json");
  }

  private readCache(): CodexCliUpdateCache | null {
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath(), "utf8")) as Partial<CodexCliUpdateCache>;
      if (parsed.schema !== 2 || typeof parsed.source !== "string" || typeof parsed.executablePath !== "string" || parsed.source !== this.snapshot?.source || parsed.executablePath !== this.snapshot?.executablePath) return null;
      if (typeof parsed.latestVersion !== "string" || !parsed.latestVersion || typeof parsed.checkedAt !== "number" || !Number.isFinite(parsed.checkedAt)) return null;
      return { schema: 2, source: parsed.source, executablePath: parsed.executablePath, latestVersion: parsed.latestVersion, checkedAt: parsed.checkedAt };
    } catch {
      return null;
    }
  }

  private async writeCache(cache: Pick<CodexCliUpdateCache, "latestVersion" | "checkedAt">) {
    mkdirSync(this.dependencies.userDataPath(), { recursive: true });
    await writeTextFileAtomicAsync(this.cachePath(), JSON.stringify({ schema: 2, source: this.snapshot?.source || "missing", executablePath: this.snapshot?.executablePath || "", ...cache }, null, 2));
  }

  private readInstalledVersion() {
    if (this.dependencies.operations?.readInstalledVersion) return this.dependencies.operations.readInstalledVersion();
    if (this.snapshot) return Promise.resolve(this.snapshot.currentVersion);
    return this.readInstalledVersionFromNpm();
  }

  private refreshInstalledVersion() {
    if (this.dependencies.operations?.readInstalledVersion) return this.dependencies.operations.readInstalledVersion();
    if (!this.snapshot?.executablePath) return Promise.resolve("");
    const currentVersion = readCliVersion(this.snapshot.executablePath, this.environment());
    this.snapshot = { ...this.snapshot, currentVersion };
    return Promise.resolve(currentVersion);
  }

  private readLatestVersion() {
    if (this.dependencies.operations?.readLatestVersion) return this.dependencies.operations.readLatestVersion();
    if (this.snapshot?.updateStrategy === "self" && this.dependencies.fetch) return this.readLatestVersionFromGithub();
    return this.readLatestVersionFromNpm();
  }

  private async readLatestVersionFromGithub() {
    const response = await this.dependencies.fetch!("https://api.github.com/repos/openai/codex/releases/latest", { headers: { Accept: "application/vnd.github+json", "User-Agent": "AgentDesk" } });
    if (!response.ok) throw new Error(`Codex 发布源返回 ${response.status}。`);
    const value = await response.json() as { tag_name?: unknown };
    const version = typeof value.tag_name === "string" ? value.tag_name.replace(/^(?:rust-)?v/i, "") : "";
    if (!CLI_VERSION_PATTERN.test(version)) throw new Error("Codex 发布源没有返回有效版本。");
    return version;
  }

  private installVersion(version: string) {
    if (this.dependencies.operations?.installVersion) return this.dependencies.operations.installVersion(version);
    if (this.snapshot?.updateStrategy === "self" && this.snapshot.executablePath) return this.installVersionWithSelf(version);
    return this.installVersionWithNpm(version);
  }

  private installVersionWithSelf(version: string) {
    const executable = this.snapshot?.executablePath || "codex";
    const isShim = /\.(?:cmd|bat)$/i.test(executable);
    const command = isShim ? this.environment().ComSpec || "cmd.exe" : executable;
    const args = isShim ? ["/d", "/s", "/c", `""${executable}" update"`] : ["update"];
    return this.runExternalCommand(command, args, CLI_NPM_UPDATE_TIMEOUT_MS);
  }

  private async isCliInUse() {
    if (this.dependencies.isCliInUse) return this.dependencies.isCliInUse();
    if (this.platform() !== "win32") return false;
    try {
      return hasCliProcess(await readWindowsProcesses({ environment: this.environment(), track: (child) => this.dependencies.processSupervisor.track(child), terminate: (child) => this.dependencies.processSupervisor.terminate(child) }), "codex");
    } catch {
      throw new Error("无法确认 Codex 是否正在使用，为避免中断会话，本次更新已取消。");
    }
  }

  private async readInstalledVersionFromNpm() {
    try {
      const result = await this.runNpmJson(["list", "-g", CODEX_CLI_PACKAGE, "--depth=0", "--json"]);
      if (!result || typeof result !== "object") return "";
      const dependencies = (result as { dependencies?: unknown }).dependencies;
      if (!dependencies || typeof dependencies !== "object") return "";
      const entry = (dependencies as Record<string, unknown>)[CODEX_CLI_PACKAGE];
      return entry && typeof entry === "object" && typeof (entry as { version?: unknown }).version === "string"
        ? (entry as { version: string }).version
        : "";
    } catch {
      return "";
    }
  }

  private async readLatestVersionFromNpm() {
    const result = await this.runNpmJson(["view", CODEX_CLI_PACKAGE, "version", "--json"]);
    if (typeof result !== "string" || !result.trim()) throw new Error("npm 未返回最新版本");
    return result.trim();
  }

  private runNpmJson(args: string[], timeoutMs = 30_000): Promise<unknown> {
    const executable = this.platform() === "win32" ? this.environment().ComSpec || "cmd.exe" : "npm";
    const commandArgs = this.platform() === "win32" ? ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`] : args;
    return new Promise((resolve, reject) => {
      const child = this.dependencies.processSupervisor.track(spawn(executable, commandArgs, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] }));
      let settled = false;
      let timedOut = false;
      let output = "";
      let errorOutput = "";
      const append = (current: string, chunk: string) => `${current}${chunk}`.slice(-256 * 1024);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output = append(output, chunk); });
      child.stderr.on("data", (chunk: string) => { errorOutput = append(errorOutput, chunk); });
      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        void this.dependencies.processSupervisor.terminate(child).finally(() => {
          if (settled) return;
          settled = true;
          reject(new Error("npm 版本检测超时。"));
        });
      }, timeoutMs);
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        if (settled || timedOut) return;
        settled = true;
        clearTimeout(timer);
        const trimmedOutput = output.trim();
        if (code !== 0) reject(new Error(errorOutput.trim() || trimmedOutput || "npm 命令执行失败"));
        else {
          try {
            resolve(JSON.parse(trimmedOutput));
          } catch {
            reject(new Error("npm 返回了无法识别的版本信息"));
          }
        }
      });
    });
  }

  private async installVersionWithNpm(version: string) {
    if (this.snapshot?.source === "custom") throw new Error("当前使用自定义 Codex CLI，请按自定义来源更新。");
    const executable = this.platform() === "win32" ? this.environment().ComSpec || "cmd.exe" : "npm";
    const args = this.platform() === "win32"
      ? ["/d", "/s", "/c", `npm.cmd install -g ${CODEX_CLI_PACKAGE}@${version}`]
      : ["install", "-g", `${CODEX_CLI_PACKAGE}@${version}`];
    await this.runExternalCommand(executable, args, CLI_NPM_UPDATE_TIMEOUT_MS);
  }

  private runExternalCommand(executable: string, args: string[], timeoutMs = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.dependencies.processSupervisor.track(spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] }));
      let settled = false;
      let timedOut = false;
      let outputTail = "";
      let errorTail = "";
      const appendTail = (current: string, chunk: string) => `${current}${chunk}`.slice(-32 * 1024);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { outputTail = appendTail(outputTail, chunk); });
      child.stderr.on("data", (chunk: string) => { errorTail = appendTail(errorTail, chunk); });
      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (settled) return;
        timedOut = true;
        void this.dependencies.processSupervisor.terminate(child).finally(() => {
          if (settled) return;
          settled = true;
          reject(new Error("Codex CLI 更新超时。"));
        });
      }, timeoutMs) : null;
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        if (settled || timedOut) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(errorTail.trim() || outputTail.trim() || `Codex CLI 更新进程退出，代码 ${code ?? "未知"}。`));
      });
    });
  }

  async prepareAppServerUpdate() {
    const ownedAppServers = [this.dependencies.appServer, ...(this.dependencies.additionalAppServers || [])];
    // Call close on every owned runtime, including one whose child is still
    // being spawned. CodexAppServer.close() waits for that startup race and
    // prevents an update from leaving a late app-server process alive.
    const results = await Promise.allSettled(ownedAppServers.map((server) => server.close()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private errorMessage(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (/custom Codex CLI|自定义 Codex CLI/i.test(message)) return "当前使用自定义 Codex CLI，请按自定义来源更新。";
    if (/timed out|ETIMEDOUT|timeout|超时/i.test(message)) return "更新超时，请稍后重试。";
    if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|network|net::/i.test(message)) return "无法连接 npm 仓库，请检查网络连接后重试。";
    if (/正在被会话使用|无法确认 Codex|启动时记录|app-server|进程列表|无法读取本机进程/i.test(message)) return message;
    return "更新失败，请稍后重试。";
  }
}
