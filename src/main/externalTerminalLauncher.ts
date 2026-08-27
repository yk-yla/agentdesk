import path from "node:path";
import type { ExternalTerminalSettings } from "../shared/protocol";

export interface ExternalTerminalLaunchPlan {
  executable: string;
  args: string[];
  mode: "direct" | "visible-console";
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
