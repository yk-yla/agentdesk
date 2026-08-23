export interface ClaudeTerminalSettings {
  model?: string;
  effort?: string;
}

export interface TerminalSettingsParseResult {
  settings: ClaudeTerminalSettings;
  buffer: string;
}

const ANSI_SEQUENCE = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
// Claude's model picker has used both the compact `high · /effort` status
// line and the newer `High effort (default)` label. Keep the surrounding
// marker mandatory so ordinary prose containing "high" is not parsed.
const EFFORT_PATTERN = /\b(low|medium|high|xhigh|max)\b\s*(?:effort(?:\s+\(default\))?|[·•]\s*\/effort)/gi;
const MODEL_PATTERN = /\|\s*([^|\r\n]+?)\s*\|\s*ctx\s*:/gi;
const MODEL_COMMAND_PATTERN = /\/model\s+([^\s\r\n]+)(?:\r|\n)/gi;
const SELECTED_MODEL_PATTERN = /(?:^|[\r\n])\s*(?:[>›❯]\s*)?\d+\.\s*(.+?)\s*[✓✔](?:\s|$)/g;
const MAX_PARSE_BUFFER = 16 * 1024;

/**
 * Claude Code displays friendly names in its TUI, but the SDK accepts the
 * provider alias or the complete model ID. Keep this mapping deliberately
 * small and explicit: unknown values must never be guessed and sent as a
 * display label.
 */
const CLAUDE_MODEL_DISPLAY_MAP: Array<{ prefix: string; id: string }> = [
  { prefix: "Default (recommended)", id: "default" },
  { prefix: "Default", id: "default" },
  { prefix: "Opus 4.6 (1M context)", id: "claude-opus-4-6[1m]" },
  { prefix: "Opus 4.6", id: "claude-opus-4-6" },
  { prefix: "Opus (1M context)", id: "opus[1m]" },
  { prefix: "Opus", id: "opus" },
  { prefix: "Sonnet 5 (1M context)", id: "sonnet[1m]" },
  { prefix: "Sonnet 5", id: "sonnet" },
  { prefix: "Sonnet (1M context)", id: "sonnet[1m]" },
  { prefix: "Sonnet", id: "sonnet" },
  { prefix: "Haiku", id: "haiku" },
];

function cleanTerminalText(value: string) {
  return value.replace(ANSI_SEQUENCE, "").replace(/\u0000/g, "");
}

function lastMatch(text: string, pattern: RegExp) {
  pattern.lastIndex = 0;
  let result: RegExpExecArray | null = null;
  let current: RegExpExecArray | null;
  while ((current = pattern.exec(text))) result = current;
  pattern.lastIndex = 0;
  return result;
}

function lastMatchWithIndex(text: string, pattern: RegExp) {
  const match = lastMatch(text, pattern);
  return match && typeof match.index === "number" ? { match, index: match.index } : undefined;
}

function modelIdFromDisplayName(value: string) {
  const display = value.replace(/[✓✔].*$/, "").trim();
  return CLAUDE_MODEL_DISPLAY_MAP.find((entry) => display.startsWith(entry.prefix))?.id;
}

function modelIdFromStatusName(value: string) {
  const display = value.replace(/[✓✔].*$/, "").trim();
  if (display.startsWith("Opus 4.6 (1M context)")) return "claude-opus-4-6[1m]";
  if (display.startsWith("Opus 4.6")) return "claude-opus-4-6";
  return undefined;
}

function modelFromBuffer(buffer: string) {
  const statusMatch = lastMatchWithIndex(buffer, MODEL_PATTERN);
  const selectedMatch = lastMatchWithIndex(buffer, SELECTED_MODEL_PATTERN);
  const latest = statusMatch && selectedMatch
    ? statusMatch.index > selectedMatch.index ? statusMatch.match : selectedMatch.match
    : statusMatch?.match || selectedMatch?.match;
  if (!latest) return undefined;
  const display = latest[1]?.trim();
  if (!display) return undefined;
  return latest === statusMatch?.match ? modelIdFromStatusName(display) : modelIdFromDisplayName(display);
}

export interface TerminalInputParseResult {
  settings: ClaudeTerminalSettings;
  buffer: string;
}

/** Parse a manually typed `/model <id>` command before it is sent to the PTY. */
export function parseClaudeTerminalInput(data: string, previousBuffer = ""): TerminalInputParseResult {
  const next = `${previousBuffer}${data}`.slice(-2_048);
  const settings: ClaudeTerminalSettings = {};
  const model = lastMatch(next, MODEL_COMMAND_PATTERN)?.[1]?.trim();
  if (model && model.length <= 160) settings.model = model;
  const lastBreak = Math.max(next.lastIndexOf("\r"), next.lastIndexOf("\n"));
  return { settings, buffer: lastBreak >= 0 ? next.slice(lastBreak + 1) : next };
}

export function parseClaudeTerminalSettings(data: string, previousBuffer = ""): TerminalSettingsParseResult {
  const buffer = `${previousBuffer}${cleanTerminalText(data)}`.slice(-MAX_PARSE_BUFFER);
  const settings: ClaudeTerminalSettings = {};
  const model = modelFromBuffer(buffer);
  if (model && model.length <= 160) settings.model = model;
  const effort = lastMatch(buffer, EFFORT_PATTERN)?.[1]?.toLowerCase();
  if (effort) settings.effort = effort;
  return { settings, buffer };
}
