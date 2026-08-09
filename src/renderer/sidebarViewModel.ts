import type { AgentProvider } from "../shared/agentProtocol";
import { sameDirectory, type HistoryThread } from "./domain";

export interface SidebarHistoryFilter {
  entries: HistoryThread[];
  provider: "all" | AgentProvider;
  query: string;
  applyTitleFilter: boolean;
}

export function filterSidebarHistory({ entries, provider, query, applyTitleFilter }: SidebarHistoryFilter) {
  const byProvider = provider === "all" ? entries : entries.filter((entry) => entry.provider === provider);
  const normalizedQuery = query.trim().toLowerCase();
  return applyTitleFilter && normalizedQuery
    ? byProvider.filter((entry) => entry.titleLower.includes(normalizedQuery))
    : byProvider;
}

export function reorderFavoriteWorkspaceList(workspaces: string[], source: string | null, target: string) {
  if (!source || sameDirectory(source, target)) return workspaces;
  const sourceIndex = workspaces.findIndex((directory) => sameDirectory(directory, source));
  const targetIndex = workspaces.findIndex((directory) => sameDirectory(directory, target));
  if (sourceIndex < 0 || targetIndex < 0) return workspaces;
  const next = [...workspaces];
  const [moved] = next.splice(sourceIndex, 1);
  if (!moved) return workspaces;
  next.splice(targetIndex, 0, moved);
  return next;
}
