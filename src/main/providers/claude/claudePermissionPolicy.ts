import type { PermissionResult, Settings } from "@anthropic-ai/claude-agent-sdk";

export function settingsWithoutClaudePermissionRules(settings: Settings): Settings {
  const { permissions: _permissions, ...rest } = settings;
  return rest;
}

export function automaticClaudeToolPermission(
  toolName: string,
  input: Record<string, unknown>,
): PermissionResult | null {
  if (toolName === "AskUserQuestion") return null;
  return { behavior: "allow", updatedInput: input };
}
