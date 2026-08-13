import { FolderOpen, GripVertical, Pin, Terminal, X } from "lucide-react";
import { memo, useState, type DragEvent as ReactDragEvent } from "react";
import type { AgentProvider } from "../shared/agentProtocol";
import type { DesktopPreferences } from "../shared/protocol";
import { basename, sameDirectory } from "./domain";
import ProviderIcon from "./ProviderIcon";
import { reorderFavoriteWorkspaceList } from "./sidebarViewModel";

export interface WorkspaceNavigationViewModel {
  currentCwd: string;
  activeCwd: string;
  currentDirectoryHistoryCount: number;
  favoriteWorkspaces: string[];
}

export interface WorkspaceNavigationActions {
  onNewSession: (cwd: string, provider?: AgentProvider) => void;
  onSelectWorkspace: (directory: string) => void;
  onToggleFavorite: (directory: string) => void;
  onSavePreference: (patch: Partial<DesktopPreferences>) => void;
  onOpenTerminal: (directory: string) => void | Promise<void>;
}

export interface WorkspaceNavigationProps {
  viewModel: WorkspaceNavigationViewModel;
  actions: WorkspaceNavigationActions;
}

function WorkspaceNavigationBase({ viewModel, actions }: WorkspaceNavigationProps) {
  const { currentCwd, activeCwd, currentDirectoryHistoryCount, favoriteWorkspaces } = viewModel;
  const { onNewSession, onSelectWorkspace, onToggleFavorite, onSavePreference, onOpenTerminal } = actions;
  const [draggingWorkspace, setDraggingWorkspace] = useState<string | null>(null);
  const [dragOverWorkspace, setDragOverWorkspace] = useState<string | null>(null);
  const [openingTerminal, setOpeningTerminal] = useState<string | null>(null);
  const currentWorkspaceFavorite = favoriteWorkspaces.some((directory) => sameDirectory(directory, currentCwd));

  const clearDrag = () => {
    setDraggingWorkspace(null);
    setDragOverWorkspace(null);
  };

  const reorder = (targetDirectory: string) => {
    const next = reorderFavoriteWorkspaceList(favoriteWorkspaces, draggingWorkspace, targetDirectory);
    if (next !== favoriteWorkspaces) onSavePreference({ favoriteWorkspaces: next });
  };

  const openTerminal = (directory: string) => {
    if (openingTerminal && sameDirectory(openingTerminal, directory)) return;
    setOpeningTerminal(directory);
    Promise.resolve(onOpenTerminal(directory)).finally(() => {
      window.setTimeout(() => setOpeningTerminal((current) => current && sameDirectory(current, directory) ? null : current), 1_200);
    });
  };

  return <>
    <div className="current-workspace" title={currentCwd}>
      <FolderOpen size={16} />
      <div className="current-workspace-copy">
        <span className="current-workspace-label"><span>当前目录</span><span>{currentDirectoryHistoryCount}</span></span>
        <strong>{basename(currentCwd)}</strong>
      </div>
      <div className="current-workspace-actions">
        <button className="current-workspace-new provider-new-codex" onClick={() => onNewSession(currentCwd, "codex")} title="在当前目录新建 Codex 会话" aria-label="在当前目录新建 Codex 会话"><ProviderIcon provider="codex" size={14} /></button>
        <button className="current-workspace-new provider-new-claude" onClick={() => onNewSession(currentCwd, "claude")} title="在当前目录新建 Claude Code 会话" aria-label="在当前目录新建 Claude Code 会话"><ProviderIcon provider="claude" size={14} /></button>
        <button className="current-workspace-terminal" onClick={() => openTerminal(currentCwd)} disabled={Boolean(openingTerminal && sameDirectory(openingTerminal, currentCwd))} title="在 WT 打开当前目录" aria-label="在 WT 打开当前目录"><Terminal size={13} /></button>
        <button className={`current-workspace-pin ${currentWorkspaceFavorite ? "active" : ""}`} onClick={() => onToggleFavorite(currentCwd)} title={currentWorkspaceFavorite ? "取消固定当前目录" : "固定当前目录"} aria-label={currentWorkspaceFavorite ? "取消固定当前目录" : "固定当前目录"} aria-pressed={currentWorkspaceFavorite}>
          <Pin size={13} fill={currentWorkspaceFavorite ? "currentColor" : "none"} />
        </button>
      </div>
    </div>
    {favoriteWorkspaces.length ? <div className="favorites-section">
      <div className="workspace-shortcuts">{favoriteWorkspaces.map((directory) => <div className={`shortcut-row ${dragOverWorkspace === directory ? "drag-over" : ""}`} key={directory} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragOverWorkspace(directory); }} onDrop={(event) => { event.preventDefault(); reorder(directory); clearDrag(); }}>
        <button type="button" className="shortcut-drag-handle" draggable onDragStart={(event: ReactDragEvent<HTMLButtonElement>) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", directory); setDraggingWorkspace(directory); }} onDragEnd={clearDrag} title="拖动调整固定目录顺序" aria-label={`拖动 ${basename(directory)} 调整固定目录顺序`}><GripVertical size={13} /></button>
        <button className={`workspace-shortcut ${sameDirectory(directory, activeCwd) ? "active" : ""}`} onClick={() => onSelectWorkspace(directory)} title={directory}><Pin size={12} /><span>{basename(directory)}</span></button>
        <button className="shortcut-new provider-codex" onClick={() => onNewSession(directory, "codex")} title="新建 Codex 会话" aria-label="新建 Codex 会话"><ProviderIcon provider="codex" size={14} /></button>
        <button className="shortcut-new provider-claude" onClick={() => onNewSession(directory, "claude")} title="新建 Claude Code 会话" aria-label="新建 Claude Code 会话"><ProviderIcon provider="claude" size={14} /></button>
        <button className="shortcut-terminal" onClick={() => openTerminal(directory)} disabled={Boolean(openingTerminal && sameDirectory(openingTerminal, directory))} title="在 WT 打开目录" aria-label={`在 WT 打开 ${basename(directory)}`}><Terminal size={13} /></button>
        <button className="shortcut-pin active" onClick={() => onToggleFavorite(directory)} title="取消固定" aria-label="取消固定"><X size={11} /></button>
      </div>)}</div>
    </div> : null}
  </>;
}

export default memo(WorkspaceNavigationBase);
