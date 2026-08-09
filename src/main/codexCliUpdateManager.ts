import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CodexCliUpdateStatus } from "../shared/protocol";
import { SingleFlight } from "./asyncOperation";
import { writeTextFileAtomic } from "./atomicFile";
import { ProcessSupervisor } from "./processSupervisor";
import { CLI_VERSION_PATTERN, compareVersions } from "./version";

export { compareVersions } from "./version";

const CODEX_CLI_PACKAGE = "@openai/codex";
const CLI_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CLI_RETRY_MS = 30 * 60 * 1000;
const CLI_NPM_UPDATE_TIMEOUT_MS = 30 * 60 * 1000;
const APP_SERVER_SCAN_TIMEOUT_MS = 10_000;

interface CodexCliUpdateCache {
  latestVersion: string;
  checkedAt: number;
}

export interface WindowsProcessSnapshot {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
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
  stopAppServers(): Promise<number>;
}

export interface CodexCliUpdateManagerDependencies {
  processSupervisor: ProcessSupervisor;
  appServer: CodexAppServerControl;
  userDataPath(): string;
  isQuitting(): boolean;
  emitStatus(status: CodexCliUpdateStatus): void;
  notify(title: string, body: string): void;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  operations?: Partial<CodexCliUpdateOperations>;
}

export function isCodexAppServerProcess(processEntry: WindowsProcessSnapshot) {
  const commandLine = processEntry.commandLine;
  if (!/(?:^|\s|["'])app-server(?:\s|$|["'])/i.test(commandLine)) return false;
  return /@openai[\\/]codex/i.test(commandLine)
    || /(?:^|[\\/\s"'])codex(?:\.cmd|\.js|\.exe)?(?:[\\/\s"']|$)/i.test(commandLine);
}

export function findCodexAppServerRoots(processes: WindowsProcessSnapshot[]) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const candidates = processes.filter(isCodexAppServerProcess);
  const candidateIds = new Set(candidates.map((entry) => entry.pid));
  const roots = new Map<number, WindowsProcessSnapshot>();
  for (const candidate of candidates) {
    let root = candidate;
    const visited = new Set<number>([root.pid]);
    while (candidateIds.has(root.parentPid) && !visited.has(root.parentPid)) {
      const parent = byPid.get(root.parentPid);
      if (!parent) break;
      root = parent;
      visited.add(root.pid);
    }
    roots.set(root.pid, root);
  }
  return [...roots.values()];
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
        this.writeCache({ latestVersion, checkedAt });
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
          return this.setStatus({ phase: "error", currentVersion, message: "重试失败，将按 6 小时周期再检查。" });
        }
        this.scheduleCheck(CLI_RETRY_MS, true);
        return this.setStatus({ phase: "error", currentVersion, message: "无法连接 npm，30 分钟后重试一次。" });
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
        if (this.environment().CODEX_DESKTOP_CLI) throw new Error("当前使用自定义 Codex CLI，请按自定义来源更新。");
        currentVersion = await this.readInstalledVersion();
        if (this.dependencies.isQuitting()) return this.currentStatus();
        if (!currentVersion) return this.setStatus({ phase: "notInstalled", currentVersion: "", message: "未检测到全局安装的 Codex CLI。" });
        if (!latestVersion || !CLI_VERSION_PATTERN.test(latestVersion) || compareVersions(latestVersion, currentVersion) <= 0) {
          return this.setStatus({ phase: "upToDate", currentVersion, latestVersion: latestVersion || currentVersion, checkedAt: Date.now(), message: "当前已经是最新版本。" });
        }
        this.dispose();
        shouldRestartLocalAppServer = this.dependencies.appServer.isRunning;
        this.suppressExitNotification = shouldRestartLocalAppServer;
        this.setStatus({ phase: "updating", currentVersion, latestVersion, message: "正在停止所有 Codex app-server。", nextCheckAt: undefined });
        const stoppedCount = await this.stopAppServers();
        if (this.dependencies.isQuitting()) return this.currentStatus();
        this.setStatus({ phase: "updating", currentVersion, latestVersion, message: `已停止 ${stoppedCount} 个 Codex app-server，正在更新到 ${latestVersion}。`, nextCheckAt: undefined });
        await this.installVersion(latestVersion);
        if (this.dependencies.isQuitting()) return this.currentStatus();
        const installedVersion = await this.readInstalledVersion();
        if (installedVersion !== latestVersion) throw new Error(`更新后检测到版本 ${installedVersion || "未知"}，不是 ${latestVersion}。`);
        const restartError = await restoreLocalAppServer();
        const checkedAt = Date.now();
        this.writeCache({ latestVersion: installedVersion, checkedAt });
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
    this.status = { ...this.status, ...patch };
    const status = this.currentStatus();
    this.dependencies.emitStatus(status);
    return status;
  }

  private scheduleCheck(delayMs: number, retrying = false) {
    this.dispose();
    const safeDelay = Math.max(1_000, Math.min(delayMs, 2_147_000_000));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check(false, retrying);
    }, safeDelay);
    this.timer.unref?.();
    this.setStatus({ nextCheckAt: Date.now() + safeDelay });
  }

  private cachePath() {
    return path.join(this.dependencies.userDataPath(), "codex-cli-update-cache.json");
  }

  private readCache(): CodexCliUpdateCache | null {
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath(), "utf8")) as Partial<CodexCliUpdateCache>;
      if (typeof parsed.latestVersion !== "string" || !parsed.latestVersion || typeof parsed.checkedAt !== "number" || !Number.isFinite(parsed.checkedAt)) return null;
      return { latestVersion: parsed.latestVersion, checkedAt: parsed.checkedAt };
    } catch {
      return null;
    }
  }

  private writeCache(cache: CodexCliUpdateCache) {
    mkdirSync(this.dependencies.userDataPath(), { recursive: true });
    writeTextFileAtomic(this.cachePath(), JSON.stringify(cache, null, 2));
  }

  private readInstalledVersion() {
    return this.dependencies.operations?.readInstalledVersion?.() || this.readInstalledVersionFromNpm();
  }

  private readLatestVersion() {
    return this.dependencies.operations?.readLatestVersion?.() || this.readLatestVersionFromNpm();
  }

  private installVersion(version: string) {
    return this.dependencies.operations?.installVersion?.(version) || this.installVersionWithNpm(version);
  }

  private stopAppServers() {
    return this.dependencies.operations?.stopAppServers?.() || this.stopAllAppServers();
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
    if (this.environment().CODEX_DESKTOP_CLI) throw new Error("当前使用自定义 Codex CLI，请按自定义来源更新。");
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

  private async readWindowsProcessSnapshot(): Promise<WindowsProcessSnapshot[]> {
    if (this.platform() !== "win32") return [];
    const systemRoot = this.environment().SystemRoot;
    const bundledPowerShell = systemRoot ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "";
    const powershell = bundledPowerShell && existsSync(bundledPowerShell) ? bundledPowerShell : "powershell.exe";
    const command = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    const output = await new Promise<string>((resolve, reject) => {
      const child = this.dependencies.processSupervisor.track(spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      }));
      let settled = false;
      let timedOut = false;
      let stdout = "";
      let stderr = "";
      const append = (current: string, chunk: string) => `${current}${chunk}`.slice(-4 * 1024 * 1024);
      child.stdout.on("data", (chunk: Buffer | string) => { stdout = append(stdout, chunk.toString()); });
      child.stderr.on("data", (chunk: Buffer | string) => { stderr = append(stderr, chunk.toString()); });
      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        void this.dependencies.processSupervisor.terminate(child).finally(() => {
          if (settled) return;
          settled = true;
          reject(new Error("读取本机进程列表超时。"));
        });
      }, APP_SERVER_SCAN_TIMEOUT_MS);
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
        if (code !== 0) reject(new Error(stderr.trim() || "无法读取本机进程列表。"));
        else if (!stdout.trim()) reject(new Error(stderr.trim() || "无法读取本机进程列表。"));
        else resolve(stdout.trim());
      });
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error("本机进程列表格式无法识别。");
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const entry = value as Record<string, unknown>;
      const pid = Number(entry.ProcessId);
      const parentPid = Number(entry.ParentProcessId);
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || parentPid < 0) return [];
      return [{
        pid,
        parentPid,
        name: typeof entry.Name === "string" ? entry.Name : "",
        commandLine: typeof entry.CommandLine === "string" ? entry.CommandLine : "",
      }];
    });
  }

  async stopAllAppServers() {
    const initialRoots = findCodexAppServerRoots(await this.readWindowsProcessSnapshot());
    const stoppedRootPids = new Set(initialRoots.map((entry) => entry.pid));
    if (this.dependencies.appServer.isRunning) await this.dependencies.appServer.close();
    for (const root of findCodexAppServerRoots(await this.readWindowsProcessSnapshot())) {
      stoppedRootPids.add(root.pid);
      await this.dependencies.processSupervisor.terminatePid(root.pid);
    }
    const remaining = findCodexAppServerRoots(await this.readWindowsProcessSnapshot());
    if (remaining.length) throw new Error(`仍有 ${remaining.length} 个 Codex app-server 未能停止。`);
    return stoppedRootPids.size;
  }

  private errorMessage(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (/custom Codex CLI|自定义 Codex CLI/i.test(message)) return "当前使用自定义 Codex CLI，请按自定义来源更新。";
    if (/timed out|ETIMEDOUT|timeout|超时/i.test(message)) return "更新超时，请稍后重试。";
    if (/app-server|进程列表|无法读取本机进程/i.test(message)) return message;
    return "更新失败，请稍后重试。";
  }
}
