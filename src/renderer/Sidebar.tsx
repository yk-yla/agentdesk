import { FolderOpen, Package, PanelLeftClose, PanelLeftOpen, RefreshCw } from "lucide-react";
import { memo, type PointerEvent as ReactPointerEvent } from "react";
import type { CapabilityState } from "../shared/agentProtocol";
import HistorySidebar, { type HistorySidebarProps } from "./HistorySidebar";
import ProviderIcon from "./ProviderIcon";
import SettingsPopover, { type SettingsPopoverConfig } from "./SettingsPopover";
import WorkspaceNavigation, { type WorkspaceNavigationProps } from "./WorkspaceNavigation";

export type { HistoryAction } from "./HistorySidebar";

export interface SidebarLayout {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export interface SidebarToolbar {
  pluginMarketplaceState: CapabilityState;
  onChooseWorkspace: () => void;
  onRefreshHistory: () => void;
  onOpenPlugins: () => void;
}

export interface SidebarProps {
  layout: SidebarLayout;
  toolbar: SidebarToolbar;
  workspace: WorkspaceNavigationProps;
  history: HistorySidebarProps;
  settings: SettingsPopoverConfig;
}

function SidebarBase({ layout, toolbar, workspace, history, settings }: SidebarProps) {
  const { currentCwd } = workspace.viewModel;
  return <aside className={`sidebar ${layout.collapsed ? "collapsed" : ""}`}>
    <div className="sidebar-actions">
      <div className="provider-new-group">
        <button className="new-thread-button provider-new-codex" onClick={() => workspace.actions.onNewSession(currentCwd, "codex")} title="新建 Codex 会话" aria-label="新建 Codex 会话"><ProviderIcon provider="codex" /><span className="sidebar-copy">Codex</span></button>
        <button className="new-thread-button provider-new-claude" onClick={() => workspace.actions.onNewSession(currentCwd, "claude")} title="新建 Claude Code 会话" aria-label="新建 Claude Code 会话"><ProviderIcon provider="claude" /><span className="sidebar-copy">Claude</span></button>
      </div>
      <button className="icon-button" onClick={toolbar.onChooseWorkspace} title="选择目录" aria-label="选择目录"><FolderOpen size={16} /></button>
      <button className="icon-button" onClick={toolbar.onRefreshHistory} title="刷新历史" aria-label="刷新历史"><RefreshCw size={15} /></button>
      {toolbar.pluginMarketplaceState !== "unsupported" ? <button className="icon-button" disabled={toolbar.pluginMarketplaceState !== "supported"} onClick={toolbar.onOpenPlugins} title={toolbar.pluginMarketplaceState === "supported" ? "插件市场" : "当前 Provider 的插件市场暂不可用"} aria-label="插件市场"><Package size={15} /></button> : null}
      <SettingsPopover collapsed={layout.collapsed} {...settings} />
      <button className="icon-button sidebar-toggle" onClick={layout.onToggleCollapsed} title={layout.collapsed ? "展开左侧面板" : "收起左侧面板"} aria-label={layout.collapsed ? "展开左侧面板" : "收起左侧面板"} aria-expanded={!layout.collapsed}>{layout.collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
    </div>
    <WorkspaceNavigation {...workspace} />
    <HistorySidebar {...history} />
    <div className="sidebar-resize-handle" role="separator" aria-label="调整会话列表宽度" aria-orientation="vertical" onPointerDown={layout.onResizeStart} />
  </aside>;
}

export default memo(SidebarBase);
