export const EXTERNAL_TERMINAL_PRESET_IDS = [
  "windows-terminal",
  "powershell-7",
  "windows-powershell",
  "command-prompt",
] as const;

export type ExternalTerminalPresetId = typeof EXTERNAL_TERMINAL_PRESET_IDS[number];
export type ExternalTerminalKind = ExternalTerminalPresetId | "custom";

export interface ExternalTerminalSettingsLike {
  kind?: ExternalTerminalKind;
  executable: string;
  argsTemplate: string;
}

export interface ExternalTerminalPreset {
  id: ExternalTerminalPresetId;
  label: string;
  executable: string;
  argsTemplate: string;
}

export const EXTERNAL_TERMINAL_PRESETS: readonly ExternalTerminalPreset[] = [
  {
    id: "windows-terminal",
    label: "Windows Terminal",
    executable: "wt.exe",
    argsTemplate: '-d "{cwd}" powershell.exe -NoExit -Command "claude --session-id {sessionId} {prompt}"',
  },
  {
    id: "powershell-7",
    label: "PowerShell 7",
    executable: "pwsh.exe",
    argsTemplate: '-NoExit -Command "claude --session-id {sessionId} {prompt}"',
  },
  {
    id: "windows-powershell",
    label: "Windows PowerShell",
    executable: "powershell.exe",
    argsTemplate: '-NoExit -Command "claude --session-id {sessionId} {prompt}"',
  },
  {
    id: "command-prompt",
    label: "命令提示符",
    executable: "cmd.exe",
    argsTemplate: '/k "claude --session-id {sessionId} {prompt}"',
  },
];

export const DEFAULT_EXTERNAL_TERMINAL_KIND: ExternalTerminalPresetId = "windows-terminal";

export function externalTerminalPreset(id: unknown): ExternalTerminalPreset | undefined {
  return EXTERNAL_TERMINAL_PRESETS.find((preset) => preset.id === id);
}

export function externalTerminalSettingsForPreset(id: ExternalTerminalPresetId): ExternalTerminalSettingsLike & { kind: ExternalTerminalPresetId } {
  const preset = externalTerminalPreset(id);
  if (!preset) throw new Error("未知的外部终端预设。");
  return { kind: preset.id, executable: preset.executable, argsTemplate: preset.argsTemplate };
}

function executableBasename(value: string) {
  return value.trim().replaceAll("/", "\\").split("\\").at(-1)?.toLowerCase() || "";
}

export function externalTerminalKindForSettings(value: Pick<ExternalTerminalSettingsLike, "kind" | "executable">): ExternalTerminalKind {
  if (value.kind === "custom") return "custom";
  if (value.kind && externalTerminalPreset(value.kind)) return value.kind;
  const executable = executableBasename(value.executable);
  return EXTERNAL_TERMINAL_PRESETS.find((preset) => preset.executable.toLowerCase() === executable)?.id || "custom";
}

export function externalTerminalLabel(value: Pick<ExternalTerminalSettingsLike, "kind" | "executable">) {
  const kind = externalTerminalKindForSettings(value);
  return kind === "custom" ? "自定义终端" : externalTerminalPreset(kind)!.label;
}
