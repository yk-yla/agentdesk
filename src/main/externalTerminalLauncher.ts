import path from "node:path";
import type { AgentProvider } from "../shared/agentProtocol";
import type { ExternalTerminalSettings } from "../shared/protocol";

export interface ExternalTerminalLaunchPlan {
  executable: string;
  args: string[];
  mode: "direct" | "visible-console";
}

function encodedPrompt(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

function powershellPromptExpression(value: string) {
  return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPrompt(value)}')))`;
}

function commandPromptHandoff(provider: AgentProvider, sessionId: string, initialPrompt: string, cliExecutable: string | undefined = provider, resume = false) {
  const command = cliExecutable.includes(" ") ? `& '${cliExecutable.replaceAll("'", "''")}'` : `& ${cliExecutable}`;
  const sessionArgs = provider === "codex"
    ? (resume ? ` resume '${sessionId}'` : "")
    : ` ${resume ? "--resume" : "--session-id"} '${sessionId}'`;
  const script = `${command}${sessionArgs}${initialPrompt ? ` ${powershellPromptExpression(initialPrompt)}` : ""}`;
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  return ["/k", `powershell.exe -NoProfile -EncodedCommand ${encodedScript}`];
}

export function expandExternalTerminalArgs(
  settings: ExternalTerminalSettings,
  executable: string,
  values: { cwd: string; sessionId: string; provider?: AgentProvider; resume: boolean; initialPrompt: string; cliExecutable?: string },
) {
  const provider = values.provider || "claude";
  const commandPrompt = settings.kind === "command-prompt" || path.win32.basename(executable).toLowerCase() === "cmd.exe";
  if (commandPrompt) return commandPromptHandoff(provider, values.sessionId, values.initialPrompt, values.cliExecutable, values.resume);
  let template = settings.argsTemplate;
  if (provider === "codex") {
    template = template
      .replace(/\bclaude(?:\.cmd|\.exe)?\b/giu, "codex")
      .replaceAll("{claude}", "codex")
      .replace(/\s+--(?:session-id|resume)\s+\{sessionId\}/giu, values.resume ? " resume {sessionId}" : "");
  }
  // Older saved preferences predate {prompt}. Inject it next to the session ID
  // so handoff keeps working without requiring the user to re-save settings.
  if (values.initialPrompt && !template.includes("{prompt}")) {
    const marker = "{sessionId}";
    const markerIndex = template.indexOf(marker);
    if (markerIndex < 0) throw new Error("外部终端参数模板必须包含 {sessionId}，否则无法绑定 Claude 会话。");
    const insertAt = markerIndex + marker.length;
    template = `${template.slice(0, insertAt)} {prompt}${template.slice(insertAt)}`;
  }
  const replaced = template
    .replaceAll("{cwd}", values.cwd.replaceAll("\\", "\\\\").replaceAll('"', '\\"'))
    .replaceAll("{sessionId}", values.sessionId)
    .replaceAll("{provider}", provider)
    .replaceAll("{prompt}", values.initialPrompt ? powershellPromptExpression(values.initialPrompt) : "")
    .replaceAll("{claude}", provider)
    .replaceAll("{codex}", provider);
  if (/[{}]/u.test(replaced)) throw new Error("外部终端参数模板包含未识别的变量。");
  const args: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|([^\s]+)/gu;
  for (const match of replaced.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? "";
    args.push(value.replaceAll('\\"', '"').replaceAll("\\\\", "\\"));
  }
  const explicitArgs = values.cliExecutable ? args.map((value) => {
    const cliPattern = provider === "codex" ? /^codex(?:\.cmd|\.exe)?(?:\s|$)/i : /^claude(?:\.cmd|\.exe)?(?:\s|$)/i;
    if (!cliPattern.test(value)) return value;
    const suffix = value.replace(provider === "codex" ? /^codex(?:\.cmd|\.exe)?/i : /^claude(?:\.cmd|\.exe)?/i, "");
    const escaped = values.cliExecutable!.replaceAll("'", "''");
    return commandPrompt ? `"${values.cliExecutable}"${suffix}` : `& '${escaped}'${suffix}`;
  }) : args;
  if (provider !== "claude" || !values.resume) return explicitArgs;
  return explicitArgs.map((value) => value.includes("--session-id") ? value.replaceAll("--session-id", "--resume") : value);
}

function quoteWindowsArgument(value: string) {
  if (value && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

function needsVisibleConsole(settings: ExternalTerminalSettings, executable: string) {
  if (["powershell-7", "windows-powershell", "command-prompt"].includes(settings.kind || "")) return true;
  return ["pwsh.exe", "powershell.exe", "cmd.exe"].includes(path.win32.basename(executable).toLowerCase());
}

function encodedConsoleLauncher(executable: string, args: string[], cwd: string) {
  const payload = Buffer.from(JSON.stringify({
    executable,
    arguments: args.map(quoteWindowsArgument).join(" "),
    cwd,
  }), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    "Start-Process -FilePath ([string]$payload.executable) -ArgumentList ([string]$payload.arguments) -WorkingDirectory ([string]$payload.cwd) | Out-Null",
  ].join("\n");
  return Buffer.from(script, "utf16le").toString("base64");
}

export function createExternalTerminalLaunchPlan(settings: ExternalTerminalSettings, executable: string, args: string[], cwd: string): ExternalTerminalLaunchPlan {
  if (!needsVisibleConsole(settings, executable)) return { executable, args, mode: "direct" };
  return {
    executable: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encodedConsoleLauncher(executable, args, cwd)],
    mode: "visible-console",
  };
}
