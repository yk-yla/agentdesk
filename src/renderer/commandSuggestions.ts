import { useEffect, useMemo, useState } from "react";
import type { SkillOption } from "./domain";
import type { AgentCapabilities } from "../shared/agentProtocol";

export type BuiltInCommandName = "clear" | "compact" | "status" | "review" | "mcp";

export interface BuiltInCommand {
  kind: "command";
  name: BuiltInCommandName;
  description: string;
}

export interface SkillSuggestion {
  kind: "skill";
  name: string;
  description: string;
  path: string;
  scope: string;
}

export type CommandSuggestion = BuiltInCommand | SkillSuggestion;

export type CommandUsage = Record<string, number>;

export function commandUsageKey(kind: CommandSuggestion["kind"], name: string) {
  return `${kind}:${name.toLowerCase()}`;
}

export type ResolvedComposerInput =
  | { kind: "command"; name: BuiltInCommandName }
  | { kind: "skill"; skill: SkillOption; prompt: string }
  | { kind: "message"; text: string };

export const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  { kind: "command", name: "clear", description: "新建干净会话，保留原会话历史" },
  { kind: "command", name: "compact", description: "压缩当前会话上下文" },
  { kind: "command", name: "status", description: "查看当前会话状态和用量" },
  { kind: "command", name: "review", description: "检查当前目录的未提交更改" },
  { kind: "command", name: "mcp", description: "查看 MCP 服务器状态" },
];

export function slashQuery(value: string) {
  const match = value.match(/^\s*\/([^\s]*)$/);
  return match ? match[1].toLowerCase() : null;
}

export function suggestionsFor(value: string, skills: SkillOption[], capabilities?: AgentCapabilities, recentUsage: CommandUsage = {}): CommandSuggestion[] {
  const query = slashQuery(value);
  if (query === null) return [];
  const commands = BUILT_IN_COMMANDS.filter((entry) => {
    if (!entry.name.startsWith(query)) return false;
    if (!capabilities) return true;
    if (entry.name === "compact") return capabilities.compact !== "unsupported";
    if (entry.name === "review") return capabilities.review !== "unsupported";
    if (entry.name === "mcp") return capabilities.mcp !== "unsupported";
    return true;
  });
  const builtInNames = new Set(BUILT_IN_COMMANDS.map((entry) => entry.name));
  const skillSuggestions = skills
    .filter((entry) => entry.enabled && !builtInNames.has(entry.name.toLowerCase() as BuiltInCommandName) && entry.name.toLowerCase().startsWith(query))
    .map((entry): SkillSuggestion => ({
      kind: "skill",
      name: entry.name,
      description: entry.description || "可复用工作流",
      path: entry.path,
      scope: entry.scope,
    }));
  return [...commands, ...skillSuggestions]
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => (recentUsage[commandUsageKey(right.entry.kind, right.entry.name)] || 0)
      - (recentUsage[commandUsageKey(left.entry.kind, left.entry.name)] || 0) || left.index - right.index)
    .map(({ entry }) => entry)
    .slice(0, 12);
}

export function resolveComposerInput(text: string, skills: SkillOption[], capabilities?: AgentCapabilities): ResolvedComposerInput {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return { kind: "message", text };
  const name = match[1].toLowerCase();
  const prompt = match[2]?.trim() || "";
  const command = suggestionsFor(`/${name}`, skills, capabilities).find((entry): entry is BuiltInCommand => entry.kind === "command" && entry.name === name);
  if (command && !prompt) return { kind: "command", name: command.name };
  const skill = skills.find((entry) => entry.enabled && entry.name.toLowerCase() === name);
  return skill ? { kind: "skill", skill, prompt } : { kind: "message", text };
}

export function useCommandSuggestions(value: string, skills: SkillOption[], capabilities?: AgentCapabilities, recentUsage: CommandUsage = {}) {
  const suggestions = useMemo(() => suggestionsFor(value, skills, capabilities, recentUsage), [capabilities, recentUsage, skills, value]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, suggestions.length - 1)));
  }, [suggestions.length]);

  return {
    suggestions,
    selectedIndex,
    moveSelection: (direction: 1 | -1) => {
      setSelectedIndex((current) => suggestions.length ? (current + direction + suggestions.length) % suggestions.length : 0);
    },
    selectIndex: (index: number) => setSelectedIndex(Math.max(0, Math.min(index, Math.max(0, suggestions.length - 1)))),
  };
}
