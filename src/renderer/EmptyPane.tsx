import { Columns2, FolderOpen } from "lucide-react";
import type { AgentProvider } from "../shared/agentProtocol";
import { basename, normalizedDirectory, type PaneState } from "./domain";
import ProviderIcon from "./ProviderIcon";

export interface EmptyPaneProps {
  pane: PaneState;
  cwd: string;
  isActivePane: boolean;
  onFocusPane: (paneId: string) => void;
  onChooseWorkspace: () => void | Promise<void>;
  onCreateSession: (provider: AgentProvider) => void | Promise<void>;
}

function EmptyPane({ pane, cwd, isActivePane, onFocusPane, onChooseWorkspace, onCreateSession }: EmptyPaneProps) {
  const canCreate = Boolean(normalizedDirectory(cwd) && cwd !== "正在连接工作区" && cwd !== "工作区不可用");
  return <section
    className={`main-panel pane-panel empty-pane-slot ${isActivePane ? "active-pane" : ""}`}
    data-empty-pane={pane.id}
    onMouseDown={() => onFocusPane(pane.id)}
  >
    <div className="empty-pane-content">
      <Columns2 className="empty-pane-icon" size={28} />
      <strong>空白分栏</strong>
      <span>{canCreate ? `当前目录：${basename(cwd)}` : "请先选择工作目录"}</span>
      <div className="empty-pane-actions">
        <button type="button" className="empty-pane-directory" onClick={() => void onChooseWorkspace()} title="选择工作目录">
          <FolderOpen size={14} />
          <span>选择目录</span>
        </button>
        <button type="button" disabled={!canCreate} onClick={() => void onCreateSession("codex")} title="新建 Codex 会话">
          <ProviderIcon provider="codex" size={14} />
          <span>新建 Codex</span>
        </button>
        <button type="button" disabled={!canCreate} onClick={() => void onCreateSession("claude")} title="新建 Claude Code 会话">
          <ProviderIcon provider="claude" size={14} />
          <span>新建 Claude</span>
        </button>
      </div>
    </div>
  </section>;
}

export default EmptyPane;
