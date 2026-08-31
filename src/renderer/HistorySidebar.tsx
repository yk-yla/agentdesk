import { ArrowRight, Download, FileSearch, FolderOpen, GitFork, Pencil, Pin, PinOff, Star, Terminal, Trash2, X } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import type { AgentCapabilities, AgentProvider } from "../shared/agentProtocol";
import { basename, formatRelativeTime, sameDirectory, type HistoryThread } from "./domain";
import ProviderIcon from "./ProviderIcon";
import type { HistorySearchScope } from "./historyController";
import { filterSidebarHistory } from "./sidebarViewModel";

const HISTORY_BATCH_SIZE = 80;

export type HistoryAction = "rename" | "pin" | "favorite" | "export" | "handoffCodex" | "handoffClaude" | "fork" | "delete" | "openWorkbench" | "openExternalTerminal";
export type HistoryView = "directory" | "favorites" | "recent";

export interface HistorySidebarViewModel {
  activeCwd: string;
  directoryHistory: HistoryThread[];
  favoriteHistory: HistoryThread[];
  recentHistory: HistoryThread[];
  historyHasMore: boolean;
  historyLoading: boolean;
  recentHasMore: boolean;
  recentLoading: boolean;
  historySearchResults: HistoryThread[] | null;
  historySearchLoading: boolean;
  historySearchHasMore: boolean;
  liveThreadActivity: Record<string, number>;
  activeThreadId: string | null;
  activeProvider: AgentProvider | null;
  providerCapabilities: Record<AgentProvider, AgentCapabilities>;
}

export interface HistorySidebarActions {
  onOpenHistory: (entry: HistoryThread) => void;
  onHistoryAction: (entry: HistoryThread, action: HistoryAction, value?: string) => Promise<void>;
  isHistoryWorking: (threadId: string, provider?: AgentProvider) => boolean;
  onLoadMoreHistory: () => void;
  onLoadRecent: () => void;
  onLoadMoreRecent: () => void;
  onSearchHistory: (query: string, scope: HistorySearchScope) => void;
  onLoadMoreHistorySearch: () => void;
}

export interface HistorySidebarProps {
  view: HistoryView;
  viewModel: HistorySidebarViewModel;
  actions: HistorySidebarActions;
}

function HistorySidebarBase({ view, viewModel, actions }: HistorySidebarProps) {
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(HISTORY_BATCH_SIZE);
  const [provider, setProvider] = useState<"all" | AgentProvider>("all");
  const [contextMenu, setContextMenu] = useState<{ entry: HistoryThread; x: number; y: number; working: boolean } | null>(null);
  const [renameTarget, setRenameTarget] = useState<HistoryThread | null>(null);
  const [renameName, setRenameName] = useState("");

  useEffect(() => { setVisibleCount(HISTORY_BATCH_SIZE); }, [search, viewModel.activeCwd, view]);
  useEffect(() => { setSearch(""); }, [view]);
  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);
  useEffect(() => {
    if (!renameTarget) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setRenameTarget(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [renameTarget]);

  const selected = view === "favorites"
    ? viewModel.favoriteHistory
    : viewModel.historySearchResults || (view === "recent" ? viewModel.recentHistory : viewModel.directoryHistory);
  const filtered = useMemo(() => filterSidebarHistory({ entries: selected, provider, query: search, applyTitleFilter: !viewModel.historySearchResults }), [provider, search, selected, viewModel.historySearchResults]);
  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const searchScope: HistorySearchScope = view === "recent" ? "allWorkspaces" : "directory";
  const searchLabel = view === "favorites" ? "搜索收藏会话标题" : view === "recent" ? "搜索全部最近会话标题" : "搜索当前目录会话标题";
  const searchPlaceholder = view === "favorites" ? "搜索收藏标题" : view === "recent" ? "搜索全部最近标题" : "搜索当前目录标题";
  const contentSearchLabel = view === "recent" ? "搜索所有目录会话正文" : "搜索当前目录会话正文";
  const scopeLabel = view === "favorites" ? "跨目录收藏" : view === "recent" ? "按最近更新时间排序" : "当前目录";
  const clearContentSearch = () => {
    setSearch("");
    actions.onSearchHistory("", searchScope);
  };

  return <>
    <div className={`history-search ${viewModel.historySearchResults ? "global" : ""}`}><input aria-label={searchLabel} value={search} onChange={(event) => { setSearch(event.target.value); if (viewModel.historySearchResults || viewModel.historySearchLoading) actions.onSearchHistory("", searchScope); }} placeholder={searchPlaceholder} />{viewModel.historySearchLoading && view !== "favorites" ? <small>搜索中</small> : null}{view !== "favorites" ? <button type="button" className={`bare-button history-content-search ${viewModel.historySearchResults ? "active" : ""}`} onClick={() => actions.onSearchHistory(search, searchScope)} disabled={!search.trim() || viewModel.historySearchLoading} title={contentSearchLabel} aria-label={contentSearchLabel} aria-pressed={Boolean(viewModel.historySearchResults)}><FileSearch size={14} /></button> : null}{viewModel.historySearchResults && view !== "favorites" ? <button type="button" className="bare-button" onClick={clearContentSearch} title="清除正文搜索" aria-label="清除正文搜索"><X size={12} /></button> : null}</div>
    <div className="history-filter-row">
      <span className="history-scope-label">{scopeLabel}</span>
      <div className="provider-filter" role="group" aria-label="筛选会话 Provider">
        <button className={provider === "all" ? "active" : ""} onClick={() => setProvider("all")} title="全部 Provider">全部</button>
        <button className={provider === "codex" ? "active" : ""} onClick={() => setProvider("codex")} title="只看 Codex" aria-label="只看 Codex"><ProviderIcon provider="codex" size={13} /></button>
        <button className={provider === "claude" ? "active" : ""} onClick={() => setProvider("claude")} title="只看 Claude Code" aria-label="只看 Claude Code"><ProviderIcon provider="claude" size={13} /></button>
      </div>
    </div>
    <nav className="thread-list" aria-label={view === "favorites" ? "已收藏会话列表" : view === "recent" ? "全部最近会话列表" : "当前目录会话列表"}>{visible.length ? <>
      {visible.map((entry) => {
        const working = actions.isHistoryWorking(entry.id, entry.provider);
        const marker = working ? <span className="thread-item-dot working" aria-label="工作中" /> : entry.isPinned ? <Pin className="thread-item-pin" size={12} fill="currentColor" /> : null;
        const active = viewModel.activeProvider === entry.provider && viewModel.activeThreadId === entry.id && sameDirectory(viewModel.activeCwd, entry.cwd);
        return <div className="thread-row" key={`${entry.provider}:${entry.id}`}><button className={`thread-item ${active ? "active" : ""}`} aria-current={active ? "page" : undefined} onClick={() => actions.onOpenHistory(entry)} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ entry, x: event.clientX, y: event.clientY, working }); }} title={entry.title}>
          <ProviderIcon provider={entry.provider} size={14} />{marker ? <span className="thread-item-marker">{marker}</span> : null}<span className="thread-item-text"><span className="thread-item-title">{entry.title}</span>{viewModel.historySearchResults && entry.searchSnippet ? <small className="thread-search-snippet">{entry.searchSnippet}</small> : null}{view !== "directory" || viewModel.historySearchResults ? <small className="thread-item-directory"><FolderOpen size={10} />{basename(entry.cwd)}</small> : null}</span><span className="thread-item-time">{formatRelativeTime(Math.max(entry.updatedAt, viewModel.liveThreadActivity[`${entry.provider}:${entry.id}`] || 0))}</span>{entry.isFavorite ? <Star className="thread-item-favorite" size={12} fill="currentColor" aria-label="已收藏" /> : null}
        </button></div>;
      })}
      {visible.length < filtered.length ? <button className="history-more" onClick={() => setVisibleCount((count) => count + HISTORY_BATCH_SIZE)}>加载更多 · 剩余 {filtered.length - visible.length}</button> : null}
    </> : <div className="empty-thread"><span className="sidebar-copy">{search.trim() ? "没有匹配会话" : view === "favorites" ? "暂无收藏会话" : view === "recent" ? viewModel.recentLoading ? "正在加载最近会话" : "暂无最近会话" : viewModel.historyLoading ? "正在加载当前目录会话" : "当前目录暂无会话"}</span></div>}{view !== "favorites" && viewModel.historySearchResults && viewModel.historySearchHasMore ? <button className="history-more" onClick={actions.onLoadMoreHistorySearch} disabled={viewModel.historySearchLoading}>{viewModel.historySearchLoading ? "正在加载更多结果" : "加载更多搜索结果"}</button> : view === "recent" && viewModel.recentHasMore && !viewModel.historySearchResults ? <button className="history-more" onClick={actions.onLoadMoreRecent} disabled={viewModel.recentLoading}>{viewModel.recentLoading ? "正在加载更早会话" : "加载更早会话"}</button> : view === "directory" && viewModel.historyHasMore && !viewModel.historySearchResults ? <button className="history-more" onClick={actions.onLoadMoreHistory} disabled={viewModel.historyLoading}>{viewModel.historyLoading ? "正在加载更早会话" : "加载更早会话"}</button> : null}</nav>
    {contextMenu ? <div className="tab-context-menu history-context-menu" role="menu" aria-label={`${contextMenu.entry.title} 会话操作`} style={{ left: Math.min(contextMenu.x, Math.max(8, window.innerWidth - 190)), top: Math.min(contextMenu.y, Math.max(8, window.innerHeight - 390)) }} onMouseDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
      <button type="button" role="menuitem" onClick={() => { const entry = contextMenu.entry; setContextMenu(null); void actions.onHistoryAction(entry, "openExternalTerminal"); }}><Terminal size={14} /><span>在外部终端打开</span></button>
      <div className="context-menu-separator" />
      {viewModel.providerCapabilities[contextMenu.entry.provider].rename !== "unsupported" ? <button type="button" role="menuitem" disabled={viewModel.providerCapabilities[contextMenu.entry.provider].rename !== "supported"} onClick={() => { const entry = contextMenu.entry; setContextMenu(null); setRenameName(entry.title); setRenameTarget(entry); }}><Pencil size={14} /><span>重命名</span></button> : null}
      <button type="button" role="menuitem" onClick={() => { const entry = contextMenu.entry; setContextMenu(null); void actions.onHistoryAction(entry, "pin"); }}>{contextMenu.entry.isPinned ? <PinOff size={14} /> : <Pin size={14} />}<span>{contextMenu.entry.isPinned ? "取消置顶" : "置顶"}</span></button>
      <button type="button" role="menuitem" onClick={() => { const entry = contextMenu.entry; setContextMenu(null); void actions.onHistoryAction(entry, "favorite"); }}><Star size={14} fill={contextMenu.entry.isFavorite ? "currentColor" : "none"} /><span>{contextMenu.entry.isFavorite ? "取消收藏" : "收藏"}</span></button>
      <button type="button" role="menuitem" onClick={() => { const entry = contextMenu.entry; setContextMenu(null); void actions.onHistoryAction(entry, "export"); }}><Download size={14} /><span>导出 Markdown</span></button>
      <button type="button" role="menuitem" onClick={() => { const entry = contextMenu.entry; setContextMenu(null); void actions.onHistoryAction(entry, "handoffCodex"); }}><ArrowRight size={14} /><span>交接到 Codex</span></button>
      <button type="button" role="menuitem" onClick={() => { const entry = contextMenu.entry; setContextMenu(null); void actions.onHistoryAction(entry, "handoffClaude"); }}><ArrowRight size={14} /><span>交接到 Claude Code</span></button>
      {viewModel.providerCapabilities[contextMenu.entry.provider].fork !== "unsupported" ? <button type="button" role="menuitem" disabled={contextMenu.working || viewModel.providerCapabilities[contextMenu.entry.provider].fork !== "supported"} onClick={() => { const entry = contextMenu.entry; setContextMenu(null); void actions.onHistoryAction(entry, "fork"); }}><GitFork size={14} /><span>创建分支</span></button> : null}
      {viewModel.providerCapabilities[contextMenu.entry.provider].delete !== "unsupported" ? <button className="danger" type="button" role="menuitem" disabled={contextMenu.working || viewModel.providerCapabilities[contextMenu.entry.provider].delete !== "supported"} onClick={() => { const entry = contextMenu.entry; setContextMenu(null); void actions.onHistoryAction(entry, "delete"); }}><Trash2 size={14} /><span>永久删除本机会话</span></button> : null}
    </div> : null}
    {renameTarget ? <div className="dialog-backdrop" onMouseDown={() => setRenameTarget(null)}><form className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-dialog-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); const name = renameName.trim(); if (!name) return; const entry = renameTarget; setRenameTarget(null); void actions.onHistoryAction(entry, "rename", name); }}>
      <strong id="rename-dialog-title">重命名会话</strong>
      <input autoFocus value={renameName} onChange={(event) => setRenameName(event.target.value)} aria-label="会话名称" maxLength={200} />
      <div className="rename-dialog-actions"><button type="button" onClick={() => setRenameTarget(null)}>取消</button><button type="submit" className="primary" disabled={!renameName.trim() || renameName.trim() === renameTarget.title}>保存</button></div>
    </form></div> : null}
  </>;
}

export default memo(HistorySidebarBase);
