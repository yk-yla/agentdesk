import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";
import { resolveExecutableFromPath } from "./executablePath";

export type CliProvider = "codex" | "claude";
export type CliInstallSource = "npm" | "native" | "winget" | "managed" | "custom" | "missing";

export interface CliRuntimeSnapshot {
  provider: CliProvider;
  source: CliInstallSource;
  executablePath: string;
  launcherPath?: string;
  currentVersion: string;
  detectedAt: number;
  updateStrategy: "npm" | "self" | "winget" | "none";
}

export function cliExecutableExists(value: string) {
  try {
    const stat = lstatSync(value);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function versionFromOutput(value: string) {
  return value.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0] || "";
}

export function readCliVersion(executablePath: string, environment: NodeJS.ProcessEnv = process.env) {
  if (!executablePath || !cliExecutableExists(executablePath)) return "";
  const isShim = /\.(?:cmd|bat)$/i.test(executablePath);
  const result = isShim
    ? spawnSync(environment.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${executablePath}" --version"`], { windowsHide: true, shell: false, encoding: "utf8", timeout: 10_000 })
    : spawnSync(executablePath, ["--version"], { windowsHide: true, shell: false, encoding: "utf8", timeout: 10_000 });
  return versionFromOutput(`${result.stdout || ""}\n${result.stderr || ""}`);
}

function candidate(command: string, environment: NodeJS.ProcessEnv) {
  return resolveExecutableFromPath(command, environment);
}

export function detectCliRuntime(provider: CliProvider, environment: NodeJS.ProcessEnv = process.env): CliRuntimeSnapshot {
  const configured = provider === "codex" ? environment.CODEX_DESKTOP_CLI?.trim() : environment.CLAUDE_CODE_EXECUTABLE?.trim();
  const configuredPath = configured ? candidate(configured, environment) : "";
  if (configured && !configuredPath) return { provider, source: "custom", executablePath: configured, currentVersion: "", detectedAt: Date.now(), updateStrategy: "none" };
  const launcherPath = configuredPath || candidate(provider, environment)
    || (provider === "codex" ? candidate("codex.cmd", environment) || candidate("codex.exe", environment) : candidate("claude.cmd", environment) || candidate("claude.exe", environment));
  if (!launcherPath) return { provider, source: "missing", executablePath: "", currentVersion: "", detectedAt: Date.now(), updateStrategy: "none" };
  const isCmd = /\.(?:cmd|bat)$/i.test(launcherPath);
  const wingetPath = /\\Microsoft\\(?:WinGet|WindowsApps)\\/i.test(launcherPath);
  const source: CliInstallSource = configuredPath ? "custom" : isCmd ? "npm" : provider === "claude" && wingetPath ? "winget" : "native";
  const updateStrategy = source === "npm" ? "npm" : source === "native" ? "self" : source === "winget" ? "winget" : "none";
  return { provider, source, executablePath: launcherPath, ...(isCmd ? { launcherPath } : {}), currentVersion: readCliVersion(launcherPath, environment), detectedAt: Date.now(), updateStrategy };
}

export interface CliProcessEntry {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
}

/** Returns whether a process is a registered root or a descendant of one. */
export function belongsToProcessTree(pid: number, entries: CliProcessEntry[], roots: ReadonlySet<number> | readonly number[]) {
  const rootSet = roots instanceof Set ? roots : new Set(roots);
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const visited = new Set<number>();
  let current = pid;
  while (current > 0 && !visited.has(current)) {
    if (rootSet.has(current)) return true;
    visited.add(current);
    current = byPid.get(current)?.parentPid || 0;
  }
  return false;
}

export function isCliProcess(entry: CliProcessEntry, provider: CliProvider) {
  const command = entry.commandLine.toLowerCase();
  const name = entry.name.toLowerCase();
  if (provider === "codex") return name === "codex.exe" || /@openai[\\/]+codex/.test(command) || /(?:^|[\\/\s"'])codex(?:\.exe|\.cmd)?(?:$|[\s"'])/.test(command);
  return name === "claude.exe" || /@anthropic-ai[\\/]+claude-code/.test(command) || /(?:^|[\\/\s"'])claude(?:\.exe|\.cmd)?(?:$|[\s"'])/.test(command);
}

export function hasCliProcess(entries: CliProcessEntry[], provider: CliProvider) {
  return entries.some((entry) => isCliProcess(entry, provider));
}

export function readWindowsProcesses(options: {
  environment?: NodeJS.ProcessEnv;
  track?(child: ChildProcess): void;
  terminate?(child: ChildProcess): Promise<void>;
  timeoutMs?: number;
} = {}): Promise<CliProcessEntry[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  const environment = options.environment || process.env;
  const systemRoot = environment.SystemRoot;
  const bundled = systemRoot ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "";
  const powershell = bundled && cliExecutableExists(bundled) ? bundled : "powershell.exe";
  const command = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    options.track?.(child);
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) return reject(error);
      try {
        const parsed = JSON.parse(stdout.trim()) as unknown;
        const values = Array.isArray(parsed) ? parsed : [parsed];
        resolve(values.flatMap((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return [];
          const entry = value as Record<string, unknown>;
          const pid = Number(entry.ProcessId);
          const parentPid = Number(entry.ParentProcessId);
          if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || parentPid < 0) return [];
          return [{ pid, parentPid, name: typeof entry.Name === "string" ? entry.Name : "", commandLine: typeof entry.CommandLine === "string" ? entry.CommandLine : "" }];
        }));
      } catch {
        reject(new Error(stderr.trim() || "本机进程列表格式无法识别。"));
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-4 * 1024 * 1024); });
    child.stderr?.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
    const timer = setTimeout(() => {
      if (settled) return;
      if (options.terminate) void options.terminate(child).finally(() => finish(new Error("读取本机进程列表超时。")));
      else { child.kill(); finish(new Error("读取本机进程列表超时。")); }
    }, options.timeoutMs || 10_000);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(code === 0 && stdout.trim() ? undefined : new Error(stderr.trim() || "无法读取本机进程列表。")));
  });
}

export function executableDirectory(snapshot: CliRuntimeSnapshot) {
  return snapshot.executablePath ? path.dirname(snapshot.executablePath) : "";
}
