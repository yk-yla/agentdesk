import { Clock3, Columns2, FolderOpen, PanelLeftClose, PanelLeftOpen, Star } from "lucide-react";
import { memo, useState, type PointerEvent as ReactPointerEvent } from "react";
import HistorySidebar, { type HistorySidebarProps, type HistoryView } from "./HistorySidebar";
import SettingsPopover, { type SettingsPopoverConfig } from "./SettingsPopover";
import WorkspaceNavigation, { type WorkspaceNavigationProps } from "./WorkspaceNavigation";

export type { HistoryAction } from "./HistorySidebar";

export interface SidebarLayout {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export interface SidebarToolbar {
  splitDisabled: boolean;
  onChooseWorkspace: () => void;
  onSplitPane: () => void;
}

export interface SidebarProps {
  layout: SidebarLayout;
  toolbar: SidebarToolbar;
  workspace: WorkspaceNavigationProps;
  history: Omit<HistorySidebarProps, "view">;
  settings: SettingsPopoverConfig;
}

function SidebarBase({ layout, toolbar, workspace, history, settings }: SidebarProps) {
  const [historyView, setHistoryView] = useState<HistoryView>("directory");
  const selectHistoryView = (view: HistoryView) => {
    setHistoryView(view);
    history.actions.onSearchHistory("", view === "recent" ? "allWorkspaces" : "directory");
    if (view === "recent") history.actions.onLoadRecent();
  };

  return <aside className={`sidebar ${layout.collapsed ? "collapsed" : ""}`}>
    <div className="sidebar-actions">
      <button className="icon-button" onClick={toolbar.onChooseWorkspace} title="选择目录" aria-label="选择目录"><FolderOpen size={16} /></button>
      <button className="icon-button" disabled={toolbar.splitDisabled} onClick={toolbar.onSplitPane} title="分成两列" aria-label="分成两列"><Columns2 size={16} /></button>
      <SettingsPopover collapsed={layout.collapsed} {...settings} />
      <button className="icon-button sidebar-toggle" onClick={layout.onToggleCollapsed} title={layout.collapsed ? "展开左侧面板" : "收起左侧面板"} aria-label={layout.collapsed ? "展开左侧面板" : "收起左侧面板"} aria-expanded={!layout.collapsed}>{layout.collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
    </div>
    <div className="sidebar-history-view-switch" role="tablist" aria-label="会话范围">
      <button type="button" role="tab" className={historyView === "directory" ? "active" : ""} aria-selected={historyView === "directory"} onClick={() => selectHistoryView("directory")}><FolderOpen size={12} /><span>当前目录</span></button>
      <button type="button" role="tab" className={historyView === "favorites" ? "active" : ""} aria-selected={historyView === "favorites"} onClick={() => selectHistoryView("favorites")}><Star size={12} fill={historyView === "favorites" ? "currentColor" : "none"} /><span>收藏</span></button>
      <button type="button" role="tab" className={historyView === "recent" ? "active" : ""} aria-selected={historyView === "recent"} onClick={() => selectHistoryView("recent")}><Clock3 size={12} /><span>全部最近</span></button>
    </div>
    {historyView === "directory" ? <WorkspaceNavigation {...workspace} /> : null}
    <HistorySidebar {...history} view={historyView} />
    <div className="sidebar-resize-handle" role="separator" aria-label="调整会话列表宽度" aria-orientation="vertical" onPointerDown={layout.onResizeStart} />
  </aside>;
}

export default memo(SidebarBase);
