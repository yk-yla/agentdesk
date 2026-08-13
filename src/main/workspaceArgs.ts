import type { AgentProvider } from "../shared/agentProtocol";

export function requestedWorkspaceFromArgs(
  argv: readonly string[],
  resolveDirectory: (value: string) => string | null,
) {
  const flagIndex = argv.findIndex((value) => value === "--cwd" || value.startsWith("--cwd="));
  if (flagIndex < 0) return null;

  const inlineValue = argv[flagIndex].slice("--cwd=".length);
  const candidates = inlineValue
    ? [inlineValue]
    : argv.slice(flagIndex + 1);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const resolved = resolveDirectory(candidates[index]);
    if (resolved) return resolved;
  }
  return null;
}

export function requestedProviderFromArgs(argv: readonly string[]): AgentProvider | null {
  const flagIndex = argv.findIndex((value) => value === "--provider" || value.startsWith("--provider="));
  if (flagIndex < 0) return null;
  const value = argv[flagIndex].startsWith("--provider=")
    ? argv[flagIndex].slice("--provider=".length)
    : argv[flagIndex + 1] || "";
  const normalized = value.trim().toLowerCase();
  return normalized === "codex" || normalized === "claude" ? normalized : null;
}

export function startupWorkspace(
  explicitWorkspace: string | null,
  savedWorkspace: string | null,
  fallbackWorkspace: string,
) {
  return explicitWorkspace || savedWorkspace || fallbackWorkspace;
}
