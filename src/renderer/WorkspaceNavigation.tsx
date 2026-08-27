import { Check, FolderOpen, GripVertical, LoaderCircle, Pin, X } from "lucide-react";
import { memo, useState, type DragEvent as ReactDragEvent } from "react";
import type { AgentProvider } from "../shared/agentProtocol";
import type { DesktopPreferences } from "../shared/protocol";
import { basename, sameDirectory } from "./domain";
import ProviderIcon from "./ProviderIcon";
import { reorderFavoriteWorkspaceList } from "./sidebarViewModel";
import { userFacingErrorMessage } from "./errorMessage";

export interface WorkspaceNavigationViewModel {
  currentCwd: string;
  activeCwd: string;
  currentDirectoryHistoryCount: number;
  favoriteWorkspaces: string[];
}

export interface WorkspaceNavigationActions {
  onNewSession: (cwd: string, provider?: AgentProvider) => void;
  onOpenClaudeTerminal: (cwd: string) => void | Promise<void>;
  onSelectWorkspace: (directory: string) => void;
  onToggleFavorite: (directory: string) => void;
  onSavePreference: (patch: Partial<DesktopPreferences>) => void;
  onOpenDirectory: (directory: string) => void | Promise<void>;
}

export interface WorkspaceNavigationProps {
  viewModel: WorkspaceNavigationViewModel;
  actions: WorkspaceNavigationActions;
}

function WorkspaceNavigationBase({ viewModel, actions }: WorkspaceNavigationProps) {
  const { currentCwd, activeCwd, currentDirectoryHistoryCount, favoriteWorkspaces } = viewModel;
  const { onNewSession, onOpenClaudeTerminal, onSelectWorkspace, onToggleFavorite, onSavePreference, onOpenDirectory } = actions;
  const [draggingWorkspace, setDraggingWorkspace] = useState<string | null>(null);
  const [dragOverWorkspace, setDragOverWorkspace] = useState<string | null>(null);
  const [launchingClaudeDirectories, setLaunchingClaudeDirectories] = useState<string[]>([]);
  const [terminalFeedback, setTerminalFeedback] = useState<{ kind: "working" | "success" | "error"; text: string } | null>(null);
  const currentWorkspaceFavorite = favoriteWorkspaces.some((directory) => sameDirectory(directory, currentCwd));

  const isClaudeLaunching = (directory: string) => launchingClaudeDirectories.some((candidate) => sameDirectory(candidate, directory));
  const openClaudeTerminal = async (directory: string) => {
    if (isClaudeLaunching(directory)) return;
    setLaunchingClaudeDirectories((current) => [...current, directory]);
    setTerminalFeedback({ kind: "working", text: "正在打开外部终端..." });
    try {
      await onOpenClaudeTerminal(directory);
      setTerminalFeedback({ kind: "success", text: "已打开外部终端。" });
    } catch (error) {
      setTerminalFeedback({ kind: "error", text: userFacingErrorMessage(error, "打开外部终端失败。") });
    } finally {
      setLaunchingClaudeDirectories((current) => current.filter((candidate) => !sameDirectory(candidate, directory)));
    }
  };

  const clearDrag = () => {
    setDraggingWorkspace(null);
    setDragOverWorkspace(null);
  };

  const reorder = (targetDirectory: string) => {
    const next = reorderFavoriteWorkspaceList(favoriteWorkspaces, draggingWorkspace, targetDirectory);
    if (next !== favoriteWorkspaces) onSavePreference({ favoriteWorkspaces: next });
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
        <button className="current-workspace-new provider-new-claude" disabled={isClaudeLaunching(currentCwd)} onClick={() => void openClaudeTerminal(currentCwd)} title="在外部终端新建 Claude Code 会话" aria-label="在外部终端新建 Claude Code 会话">{isClaudeLaunching(currentCwd) ? <LoaderCircle className="terminal-launch-spinner" size={14} /> : <ProviderIcon provider="claude" size={14} />}</button>
        <button className="current-workspace-open" onClick={() => onOpenDirectory(currentCwd)} title="在资源管理器中打开当前目录" aria-label="在资源管理器中打开当前目录"><FolderOpen size={13} /></button>
        <button className={`current-workspace-pin ${currentWorkspaceFavorite ? "active" : ""}`} onClick={() => onToggleFavorite(currentCwd)} title={currentWorkspaceFavorite ? "取消固定当前目录" : "固定当前目录"} aria-label={currentWorkspaceFavorite ? "取消固定当前目录" : "固定当前目录"} aria-pressed={currentWorkspaceFavorite}>
          <Pin size={13} fill={currentWorkspaceFavorite ? "currentColor" : "none"} />
        </button>
      </div>
    </div>
    {terminalFeedback ? <div className={`workspace-terminal-feedback ${terminalFeedback.kind}`} role={terminalFeedback.kind === "error" ? "alert" : "status"}>{terminalFeedback.kind === "working" ? <LoaderCircle className="terminal-launch-spinner" size={13} /> : terminalFeedback.kind === "success" ? <Check size={13} /> : null}<span>{terminalFeedback.text}</span>{terminalFeedback.kind !== "working" ? <button type="button" className="bare-button" onClick={() => setTerminalFeedback(null)} title="关闭" aria-label={terminalFeedback.kind === "error" ? "关闭错误提示" : "关闭提示"}><X size={13} /></button> : null}</div> : null}
    {favoriteWorkspaces.length ? <div className="favorites-section">
      <div className="workspace-shortcuts">{favoriteWorkspaces.map((directory) => <div className={`shortcut-row ${dragOverWorkspace === directory ? "drag-over" : ""}`} key={directory} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragOverWorkspace(directory); }} onDrop={(event) => { event.preventDefault(); reorder(directory); clearDrag(); }}>
        <button type="button" className="shortcut-drag-handle" draggable onDragStart={(event: ReactDragEvent<HTMLButtonElement>) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", directory); setDraggingWorkspace(directory); }} onDragEnd={clearDrag} title="拖动调整固定目录顺序" aria-label={`拖动 ${basename(directory)} 调整固定目录顺序`}><GripVertical size={13} /></button>
        <button className={`workspace-shortcut ${sameDirectory(directory, activeCwd) ? "active" : ""}`} onClick={() => onSelectWorkspace(directory)} title={directory}><Pin size={12} /><span>{basename(directory)}</span></button>
        <div className="shortcut-actions">
          <button className="shortcut-new provider-codex" onClick={() => onNewSession(directory, "codex")} title="新建 Codex 会话" aria-label="新建 Codex 会话"><ProviderIcon provider="codex" size={14} /></button>
          <button className="shortcut-new provider-claude" disabled={isClaudeLaunching(directory)} onClick={() => void openClaudeTerminal(directory)} title="在外部终端新建 Claude Code 会话" aria-label="在外部终端新建 Claude Code 会话">{isClaudeLaunching(directory) ? <LoaderCircle className="terminal-launch-spinner" size={14} /> : <ProviderIcon provider="claude" size={14} />}</button>
          <button className="shortcut-open" onClick={() => onOpenDirectory(directory)} title="在资源管理器中打开目录" aria-label={`在资源管理器中打开 ${basename(directory)}`}><FolderOpen size={13} /></button>
          <button className="shortcut-pin active" onClick={() => onToggleFavorite(directory)} title="取消固定" aria-label="取消固定"><X size={11} /></button>
        </div>
      </div>)}</div>
    </div> : null}
  </>;
}

export default memo(WorkspaceNavigationBase);
