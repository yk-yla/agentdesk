import { CircleDot, CornerDownRight, ListChecks, PanelRight, Play, RefreshCw, Square, Terminal, X } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { AgentBridge, JsonObject } from "../shared/protocol";
import Composer from "./Composer";
import { findModelOption, formatCount, type Activity, type CollaborationMode, type ImageAttachment, type ModelOption, type PaneState, type PendingSteerMessage, type QueuedMessage, type SessionState, type SkillOption } from "./domain";
import ElapsedTimer from "./ElapsedTimer";
import GoalExecutionStrip from "./GoalExecutionStrip";
import MessageStack from "./MessageStack";
import { findQuestionAnchorIndex, QUESTION_ANCHOR_SELECTOR, QUESTION_SCROLL_TOP_PADDING, questionNavigationDirection, type QuestionNavigationDirection } from "./questionNavigation";
import ServerRequestPanel from "./ServerRequestPanel";
import { activitiesForMainConversation } from "./activityPresentation";
import type { CommandUsage } from "./commandSuggestions";
import ConversationSearch from "./conversationSearchPanel";
import { findConversationSearchMatches } from "./conversationSearch";
import { activityNoticeKey, goalNoticeKey, isActivityNoticeDismissed, isGoalNoticeDismissible } from "./sessionNoticeDismissal";
import { sessionErrorAutoDismissMs, sessionErrorNoticeIdentity } from "./sessionErrorNotice";
import { useAutoDismissNotice } from "./useAutoDismissNotice";

const DetailsPanel = lazy(() => import("./DetailsPanel"));

const NO_VISIBLE_ACTIVITIES: Activity[] = [];
const NAVIGATION_BLOCKING_SELECTOR = '[aria-modal="true"], [role="menu"], .image-lightbox, .command-suggestions';

function questionNavigationBlocked(event: KeyboardEvent) {
  const target = event.target;
  if (target instanceof Element && target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return true;
  return Boolean(document.querySelector(NAVIGATION_BLOCKING_SELECTOR));
}

export interface PaneViewProps {
  pane: PaneState;
  session: SessionState;
  isActivePane: boolean;
  isActiveTab: boolean;
  models: ModelOption[];
  skills: SkillOption[];
  recentCommandUsage: CommandUsage;
  attachments: ImageAttachment[];
  queuedMessages: QueuedMessage[];
  pendingSteers: PendingSteerMessage[];
  draftRevision: number;
  bridge: AgentBridge;
  onFocusPane: (paneId: string) => void;
  onMoveTab: (sessionId: string, targetPaneId: string, target?: { paneId: string; sessionId: string; position: "before" | "after" }, split?: "horizontal" | "vertical") => void;
  onSetSessionSetting: (sessionId: string, field: "model" | "effort", value: string) => void;
  onSetCollaborationMode: (sessionId: string, mode: CollaborationMode) => void | Promise<void>;
  onCompact: (sessionId: string) => void;
  onToggleDetails: (sessionId: string) => void;
  onSetDetailView: (sessionId: string, view: "activity" | "raw" | "goal" | "plan" | "agents") => void;
  onStartGoal: (sessionId: string, objective: string) => void;
  onStopGoal: (sessionId: string) => void;
  onClearError: (sessionId: string, expectedNoticeIdentity?: string) => void;
  dismissedNoticeKeys: readonly string[];
  onDismissNotice: (sessionId: string, noticeKeys: string | readonly string[]) => void;
  onRetryReadOnly: (sessionId: string) => void;
  onRefresh: (sessionId: string) => void;
  onLoadEarlier: (sessionId: string) => void;
  onOpenExternalTerminal: (sessionId: string) => void;
  onRespondApproval: (sessionId: string, result: JsonObject) => void;
  onInterrupt: (sessionId: string) => void;
  getDraft: (sessionId: string) => string;
  onDraftChange: (sessionId: string, value: string) => void;
  onSend: (sessionId: string, text: string, mode?: "submit" | "queue") => void;
  onCycleEffort: (sessionId: string, direction: 1 | -1) => void;
  onAddFiles: (sessionId: string, files: File[]) => Promise<string[]>;
  onRemoveImage: (sessionId: string, index: number) => void;
  onRemoveQueuedMessage: (sessionId: string, queuedId: string) => void;
  onChooseDirectory: (sessionId: string) => void;
}

/**
 * 每个分栏一个 memo 组件：只有本分栏的会话变化才重渲染，
 * 不再因为输入、计时、侧栏搜索或其他分栏的事件而整体重建。
 */
function PaneView(props: PaneViewProps) {
  const { pane, session, models, attachments, bridge } = props;
  const conversationRef = useRef<HTMLDivElement>(null);
  const conversationSearchInputRef = useRef<HTMLInputElement>(null);
  const followLatestRef = useRef(true);
  const questionNavigationScrollRef = useRef(false);
  const questionNavigationFrameRef = useRef<number | null>(null);
  const scrollStatesRef = useRef(new Map<string, { top: number; atBottom: boolean }>());
  const restoringSessionRef = useRef<string | null>(null);
  const model = useMemo(() => findModelOption(models, session.model), [models, session.model]);
  const claudeModel = useMemo(() => models.find((entry) => entry.id === session.model), [models, session.model]);
  const claudeModelLabel = session.resolvedModel
    || (session.model ? claudeModel?.displayName || session.model : "未设置");
  const efforts = useMemo(() => (model?.efforts.length ? model.efforts : [session.effort || "medium"]), [model, session.effort]);
  const supports = (capability: keyof SessionState["capabilities"]) => session.capabilities[capability] === "supported";
  const temporarilyUnavailable = (capability: keyof SessionState["capabilities"]) => session.capabilities[capability] === "temporarilyUnavailable";
  // 展示过滤只发生在渲染层，底层活动数据始终完整保留。
  const visibleActivities = useMemo(() => {
    const visible = activitiesForMainConversation(session.activities);
    return visible.length ? visible : NO_VISIBLE_ACTIVITIES;
  }, [session.activities]);
  const [locallyDismissedNoticeKeys, setLocallyDismissedNoticeKeys] = useState<Set<string>>(() => new Set());
  const dismissedNoticeKeys = useMemo(
    () => new Set([...props.dismissedNoticeKeys, ...locallyDismissedNoticeKeys]),
    [locallyDismissedNoticeKeys, props.dismissedNoticeKeys],
  );
  const dismissNotices = useCallback((noticeKeys: readonly string[]) => {
    setLocallyDismissedNoticeKeys((current) => {
      if (noticeKeys.every((noticeKey) => current.has(noticeKey))) return current;
      const next = new Set(current);
      for (const noticeKey of noticeKeys) next.add(noticeKey);
      return next;
    });
    props.onDismissNotice(session.id, noticeKeys);
  }, [props.onDismissNotice, session.id]);
  const dismissNotice = useCallback((noticeKey: string) => dismissNotices([noticeKey]), [dismissNotices]);
  const emptySession = session.messages.length === 0 && visibleActivities.every((activity) => isActivityNoticeDismissed(activity, dismissedNoticeKeys));
  const latestMessageLength = session.messages[session.messages.length - 1]?.text.length ?? 0;
  const latestActivityLength = session.activities[session.activities.length - 1]?.output?.length ?? 0;
  const activeGoal = session.goal?.status === "active" ? session.goal : null;
  const goalNotice = session.goal && isGoalNoticeDismissible(session.goal)
    ? goalNoticeKey(session.goal)
    : null;
  const visibleGoal = goalNotice && dismissedNoticeKeys.has(goalNotice)
    ? null
    : session.goal;
  const currentErrorNoticeIdentity = sessionErrorNoticeIdentity(session);
  const clearCurrentError = useCallback(() => {
    props.onClearError(session.id, currentErrorNoticeIdentity || undefined);
  }, [currentErrorNoticeIdentity, props.onClearError, session.id]);
  const errorAutoDismissProps = useAutoDismissNotice(currentErrorNoticeIdentity, props.isActiveTab ? sessionErrorAutoDismissMs(session) : null, clearCurrentError);
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [conversationSearchQuery, setConversationSearchQuery] = useState("");
  const [conversationSearchIndex, setConversationSearchIndex] = useState(0);
  const conversationSearchMatches = useMemo(
    () => findConversationSearchMatches(session.messages, conversationSearchQuery),
    [conversationSearchQuery, session.messages],
  );
  const activeConversationSearchMatch = conversationSearchMatches[conversationSearchIndex] || null;

  useEffect(() => {
    setConversationSearchIndex((current) => conversationSearchMatches.length
      ? Math.min(current, conversationSearchMatches.length - 1)
      : 0);
  }, [conversationSearchMatches.length]);

  const openGoalDetails = useCallback(() => {
    if (!session.detailsOpen) props.onToggleDetails(session.id);
    props.onSetDetailView(session.id, "goal");
  }, [props.onSetDetailView, props.onToggleDetails, session.detailsOpen, session.id]);

  useEffect(() => {
    if (!session.detailsOpen) return undefined;
    const closeDetailsOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const panel = target.closest<HTMLElement>(".pane-details");
      const trigger = target.closest<HTMLElement>("[data-details-trigger]");
      const triggerPane = trigger?.closest<HTMLElement>("[data-pane-session]");
      if (panel?.dataset.detailsSession === session.id || triggerPane?.dataset.paneSession === session.id) return;
      props.onToggleDetails(session.id);
    };
    window.addEventListener("pointerdown", closeDetailsOnOutsidePointerDown);
    return () => window.removeEventListener("pointerdown", closeDetailsOnOutsidePointerDown);
  }, [props.onToggleDetails, session.detailsOpen, session.id]);

  useLayoutEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation) return undefined;
    const saved = scrollStatesRef.current.get(session.id);
    const atBottom = saved?.atBottom ?? true;
    followLatestRef.current = atBottom;
    restoringSessionRef.current = session.id;
    conversation.scrollTop = saved && !saved.atBottom
      ? Math.min(saved.top, Math.max(0, conversation.scrollHeight - conversation.clientHeight))
      : conversation.scrollHeight;
    const frame = window.requestAnimationFrame(() => {
      restoringSessionRef.current = null;
      scrollStatesRef.current.set(session.id, {
        top: conversation.scrollTop,
        atBottom: conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 80,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [session.id]);

  useLayoutEffect(() => {
    if (!followLatestRef.current) return undefined;
    const conversation = conversationRef.current;
    if (!conversation) return undefined;
    conversation.scrollTop = conversation.scrollHeight;
    scrollStatesRef.current.set(session.id, { top: conversation.scrollTop, atBottom: true });
    return undefined;
  }, [session.id, session.messages.length, latestMessageLength, session.activities.length, latestActivityLength]);

  const jumpToQuestion = useCallback((direction: QuestionNavigationDirection, loadAttempts = 0): boolean => {
    const conversation = conversationRef.current;
    if (!conversation) return false;
    const conversationTop = conversation.getBoundingClientRect().top;
    const anchors = Array.from(conversation.querySelectorAll<HTMLElement>(QUESTION_ANCHOR_SELECTOR));
    const anchorScrollTops = anchors.map((anchor) => (
      conversation.scrollTop + anchor.getBoundingClientRect().top - conversationTop - QUESTION_SCROLL_TOP_PADDING
    ));
    const anchorIndex = findQuestionAnchorIndex(anchorScrollTops, conversation.scrollTop, direction);
    if (anchorIndex >= 0) {
      const top = Math.max(0, Math.min(anchorScrollTops[anchorIndex], conversation.scrollHeight - conversation.clientHeight));
      followLatestRef.current = false;
      questionNavigationScrollRef.current = true;
      conversation.scrollTop = top;
      scrollStatesRef.current.set(session.id, { top, atBottom: false });
      questionNavigationFrameRef.current = window.requestAnimationFrame(() => {
        questionNavigationScrollRef.current = false;
        questionNavigationFrameRef.current = null;
      });
      return true;
    }
    if (direction !== "previous" || loadAttempts >= 25) return false;
    const loadEarlier = conversation.querySelector<HTMLButtonElement>("[data-load-earlier-messages]");
    if (!loadEarlier) return false;
    loadEarlier.click();
    questionNavigationFrameRef.current = window.requestAnimationFrame(() => {
      questionNavigationFrameRef.current = window.requestAnimationFrame(() => {
        questionNavigationFrameRef.current = null;
        jumpToQuestion(direction, loadAttempts + 1);
      });
    });
    return true;
  }, [session.id]);

  useEffect(() => {
    if (!props.isActivePane) return undefined;
    const handleQuestionNavigation = (event: KeyboardEvent) => {
      const direction = questionNavigationDirection(event);
      if (!direction || questionNavigationBlocked(event)) return;
      event.preventDefault();
      jumpToQuestion(direction);
    };
    window.addEventListener("keydown", handleQuestionNavigation);
    return () => {
      window.removeEventListener("keydown", handleQuestionNavigation);
      if (questionNavigationFrameRef.current !== null) window.cancelAnimationFrame(questionNavigationFrameRef.current);
      questionNavigationFrameRef.current = null;
    };
  }, [jumpToQuestion, props.isActivePane]);

  useEffect(() => {
    if (!props.isActivePane) return undefined;
    const handleConversationSearchShortcut = (event: KeyboardEvent) => {
      if (!((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") || event.altKey) return;
      if (session.detailsOpen) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      setConversationSearchOpen(true);
    };
    window.addEventListener("keydown", handleConversationSearchShortcut, true);
    return () => window.removeEventListener("keydown", handleConversationSearchShortcut, true);
  }, [props.isActivePane, session.detailsOpen]);

  useEffect(() => {
    if (!conversationSearchOpen) return undefined;
    const handleConversationSearchClose = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      setConversationSearchOpen(false);
    };
    window.addEventListener("keydown", handleConversationSearchClose);
    return () => window.removeEventListener("keydown", handleConversationSearchClose);
  }, [conversationSearchOpen]);

  useEffect(() => {
    if (session.detailsOpen) setConversationSearchOpen(false);
  }, [session.detailsOpen]);

  useEffect(() => {
    if (!conversationSearchOpen || !activeConversationSearchMatch) return undefined;
    let secondFrame: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const target = conversationRef.current?.querySelector<HTMLElement>(`[data-search-active="true"]`);
        target?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [activeConversationSearchMatch, conversationSearchOpen, conversationSearchQuery, session.messages.length]);

  const openConversationSearch = useCallback(() => {
    setConversationSearchOpen(true);
  }, []);

  const closeConversationSearch = useCallback(() => {
    setConversationSearchOpen(false);
  }, []);

  const updateConversationSearchQuery = useCallback((value: string) => {
    setConversationSearchQuery(value);
    setConversationSearchIndex(0);
  }, []);

  const moveConversationSearch = useCallback((direction: 1 | -1) => {
    if (!conversationSearchMatches.length) return;
    setConversationSearchIndex((current) => (current + direction + conversationSearchMatches.length) % conversationSearchMatches.length);
  }, [conversationSearchMatches.length]);

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    const tabId = event.dataTransfer.getData("text/tab");
    if (!tabId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const split = offsetX < rect.width * 0.22 ? "vertical" : offsetX > rect.width * 0.78 ? "vertical" : event.clientY - rect.top < rect.height * 0.2 ? "horizontal" : undefined;
    props.onMoveTab(tabId, pane.id, undefined, split);
  };

  const composerToolbar = useMemo(() => <div className="pane-controls">
    {session.capabilities.plans !== "unsupported" ? <div
      className={`collaboration-mode-switch ${session.collaborationMode === "plan" ? "plan-selected" : "default-selected"}`}
      role="group"
      aria-label="工作模式"
    >
      <button
        type="button"
        className={session.collaborationMode === "default" ? "selected" : ""}
        aria-pressed={session.collaborationMode === "default"}
        aria-label="执行模式"
        disabled={session.readOnly || session.status === "working" || !supports("plans")}
        onClick={() => { void props.onSetCollaborationMode(session.id, "default"); }}
        title={session.status === "working" ? "任务运行中不能切换模式" : "执行模式：直接分析并完成任务"}
      ><Play size={14} /></button>
      <button
        type="button"
        className={session.collaborationMode === "plan" ? "selected" : ""}
        aria-pressed={session.collaborationMode === "plan"}
        aria-label="计划模式"
        disabled={session.readOnly || session.status === "working" || !supports("plans")}
        onClick={() => { void props.onSetCollaborationMode(session.id, "plan"); }}
        title={session.status === "working" ? "任务运行中不能切换模式" : "计划模式：先制定方案，再根据你的确认执行"}
      ><ListChecks size={14} /></button>
    </div> : null}
    {session.capabilities.models !== "unsupported" ? session.provider === "claude" ? <span
      className="readonly-control readonly-model"
      aria-label={`当前模型：${claudeModelLabel}`}
      title={`当前模型：${claudeModelLabel}`}
    >{claudeModelLabel}</span> : <select
      value={model?.id || session.model}
      onChange={(event) => props.onSetSessionSetting(session.id, "model", event.target.value)}
      aria-label="选择模型"
      className="select-control model-select"
      title={model ? `${model.displayName}${session.resolvedModel ? ` · 实际 ${session.resolvedModel}` : ""}` : session.model}
      disabled={!supports("models") || session.readOnly}
    >
      {session.model && !model ? <option value={session.model}>{session.model}</option> : null}
      {models.length ? models.map((entry) => <option value={entry.id} key={entry.id}>{entry.displayName}</option>) : !session.model ? <option value="">加载模型</option> : null}
    </select> : null}
    {session.capabilities.effort !== "unsupported" ? session.provider === "claude" ? <span
      className="readonly-control readonly-effort"
      aria-label={`当前思考等级：${session.effort || "未设置"}`}
      title={`当前思考等级：${session.effort || "未设置"}`}
    >{session.effort || "未设置"}</span> : <select
      value={session.effort}
      onChange={(event) => props.onSetSessionSetting(session.id, "effort", event.target.value)}
      aria-label="选择思考等级"
      className="select-control effort-select"
      title={`思考等级：${session.effort}`}
      disabled={!supports("effort") || session.readOnly}
    >
      {efforts.map((effort) => <option value={effort} key={effort}>{effort}</option>)}
    </select> : null}
    {session.capabilities.contextUsage !== "unsupported" ? <span className="context-usage" title={temporarilyUnavailable("contextUsage") ? "发送首条消息后查询上下文用量" : "最近一次上下文用量"}>{formatCount(session.tokenUsage.used)}/{session.tokenUsage.total ? formatCount(session.tokenUsage.total) : "?"}</span> : null}
    {session.capabilities.compact !== "unsupported" ? <button className="compact-count" disabled={!supports("compact") || session.readOnly} onClick={() => props.onCompact(session.id)} title={temporarilyUnavailable("compact") ? "发送首条消息后可压缩上下文" : "手动压缩上下文"}>压缩 {session.compactionCount}</button> : null}
    {session.provider === "claude"
      ? <button className="detail-toggle" disabled={session.statusLabel === "正在打开外部终端"} onClick={() => props.onOpenExternalTerminal(session.id)} title="在外部终端中打开"><Terminal size={15} /><span>在终端打开</span></button>
      : <button className={`detail-toggle ${session.detailsOpen ? "selected" : ""}`} data-details-trigger={session.id} onClick={() => props.onToggleDetails(session.id)} title="查看详情"><PanelRight size={15} /><span>详情</span></button>}
  </div>, [
    claudeModelLabel, efforts, model?.displayName, models, props.onCompact, props.onSetCollaborationMode,
    props.onSetSessionSetting, props.onToggleDetails, session.collaborationMode,
    session.capabilities, session.compactionCount, session.detailsOpen, session.effort, session.id, session.model, session.provider, session.readOnly,
    session.resolvedModel, session.status, session.statusLabel,
    session.tokenUsage.total, session.tokenUsage.used,
  ]);

  return (
    <section
      className={`main-panel pane-panel ${props.isActivePane ? "active-pane" : ""}${emptySession ? " empty-pane" : ""}${props.isActiveTab ? "" : " inactive-tab"}`}
      data-pane-session={session.id}
      aria-hidden={!props.isActiveTab}
      onMouseDown={() => props.onFocusPane(pane.id)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      {!session.detailsOpen ? <ConversationSearch
        open={conversationSearchOpen}
        query={conversationSearchQuery}
        matchCount={conversationSearchMatches.length}
        activeMatchIndex={activeConversationSearchMatch ? conversationSearchIndex : 0}
        inputRef={conversationSearchInputRef}
        onOpen={openConversationSearch}
        onClose={closeConversationSearch}
        onQueryChange={updateConversationSearchQuery}
        onPrevious={() => moveConversationSearch(-1)}
        onNext={() => moveConversationSearch(1)}
      /> : null}
      <div
        className="conversation"
        aria-live="polite"
        aria-busy={session.historyLoading === true}
        ref={conversationRef}
        onScroll={(event) => {
          if (restoringSessionRef.current === session.id) return;
          const element = event.currentTarget;
          if (questionNavigationScrollRef.current) {
            questionNavigationScrollRef.current = false;
            followLatestRef.current = false;
            scrollStatesRef.current.set(session.id, { top: element.scrollTop, atBottom: false });
            return;
          }
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          followLatestRef.current = atBottom;
          scrollStatesRef.current.set(session.id, { top: element.scrollTop, atBottom });
        }}
      >
        <MessageStack
          key={session.id}
          messages={session.messages}
          visibleActivities={visibleActivities}
          bridge={bridge}
          cwd={session.cwd}
          provider={session.provider}
          searchTerm={conversationSearchOpen ? conversationSearchQuery : ""}
          activeSearchMessageId={conversationSearchOpen ? activeConversationSearchMatch?.messageId || null : null}
          activeSearchOccurrence={conversationSearchOpen ? activeConversationSearchMatch?.occurrence ?? null : null}
          searchTargetMessageIndex={conversationSearchOpen ? activeConversationSearchMatch?.messageIndex ?? null : null}
          canLoadEarlier={session.provider === "claude" && session.historyHasMoreBefore === true}
          loadingEarlier={session.historyLoadingEarlier === true}
          onLoadEarlier={session.provider === "claude" ? () => props.onLoadEarlier(session.id) : undefined}
          dismissedNoticeKeys={dismissedNoticeKeys}
          onDismissNotice={dismissNotice}
          onDismissNotices={dismissNotices}
        />
        {session.historyLoading ? <div className="history-loading-overlay" role="status" aria-busy="true">
          <RefreshCw className="history-loading-icon spin" size={16} />
          <span>正在读取会话记录…</span>
        </div> : null}
      </div>

      <div className="composer-area">
        {session.readOnly ? <div className="read-only-banner" role="status"><CircleDot size={15} /><span>{session.provider === "claude" ? <>Claude Code 会话由外部终端控制，当前为只读模式。{session.statusLabel !== "就绪" ? `（${session.statusLabel}）` : ""}</> : "该会话正被其他程序使用，当前为只读模式。"}</span>{session.provider === "claude" ? <><button type="button" disabled={session.statusLabel === "正在打开外部终端"} onClick={() => props.onOpenExternalTerminal(session.id)} title="在外部终端中打开"><Terminal size={13} />在终端中打开</button><button type="button" onClick={() => props.onRefresh(session.id)} disabled={session.historyLoading} title="重新读取外部终端中的最新消息"><RefreshCw size={13} />刷新</button></> : <><button type="button" data-details-trigger={session.id} onClick={() => props.onToggleDetails(session.id)}>{session.detailsOpen ? "关闭详情" : "查看详情"}</button><button type="button" onClick={() => props.onRetryReadOnly(session.id)}>重新尝试编辑</button></>}</div> : null}
        {session.errorText ? <div className="error-banner" role="alert" {...errorAutoDismissProps}><CircleDot size={15} /><span>{session.errorText}</span><button className="bare-button" onClick={clearCurrentError} title="关闭" aria-label="关闭错误提示"><X size={14} /></button></div> : null}
        {session.pendingApprovals[0] && !session.readOnly ? <div className="server-request-wrap"><ServerRequestPanel key={`${session.pendingApprovals[0].requestId}:${session.pendingApprovals[0].interactionId || ""}:${session.pendingApprovals[0].queryGeneration || 0}`} request={session.pendingApprovals[0]} bridge={bridge} onRespond={(result) => props.onRespondApproval(session.id, result)} />{session.pendingApprovals.length > 1 ? <span className="server-request-count">另有 {session.pendingApprovals.length - 1} 个请求等待处理</span> : null}</div> : null}
        {visibleGoal ? <GoalExecutionStrip
          goal={visibleGoal}
          working={session.status === "working"}
          readOnly={Boolean(session.readOnly)}
          stage={session.retryState ? `正在重试，第 ${session.retryState.attempt} 次：${session.retryState.message}` : session.statusLabel}
          onOpenDetails={openGoalDetails}
          onStop={() => props.onStopGoal(session.id)}
          onDismiss={() => {
            if (goalNotice) dismissNotice(goalNotice);
          }}
        /> : null}
        {session.status === "working" && !activeGoal ? <div className={`working-strip${session.retryState ? " retrying" : ""}${session.readOnly ? " read-only-working" : ""}`}>{session.retryState && !session.readOnly ? <RefreshCw className="retry-icon spin" size={14} /> : <span className="working-dot" />}<div className="working-copy"><span>{session.readOnly ? "其他程序正在执行此会话" : session.retryState ? `正在重试… 第 ${session.retryState.attempt} 次` : session.statusLabel}{!session.readOnly ? <> (<ElapsedTimer startedAt={session.startedAt} />)</> : null}</span></div>{!session.readOnly ? <button className="stop-button" onClick={() => { if (window.confirm("确认停止当前任务吗？")) props.onInterrupt(session.id); }} title="停止任务"><Square size={13} fill="currentColor" /><span>停止</span></button> : null}{session.retryState && !session.readOnly ? <span className="retry-detail"><CornerDownRight size={12} />{session.retryState.message}{session.retryState.additionalDetails ? `：${session.retryState.additionalDetails}` : ""}</span> : null}</div> : null}
        {!session.readOnly ? <Composer
          key={`${session.id}-${props.draftRevision}`}
          sessionId={session.id}
          provider={session.provider}
          cwd={session.cwd}
          threadId={session.threadId}
          skills={props.skills}
          recentCommandUsage={props.recentCommandUsage}
          capabilities={session.capabilities}
          attachments={attachments}
          queuedMessages={props.queuedMessages}
          pendingSteers={props.pendingSteers}
          working={session.status === "working"}
          placeholder={activeGoal ? "可继续补充指令或询问目标进度" : session.collaborationMode === "plan" ? "描述需要规划的任务" : undefined}
          copyImage={bridge.copyImage}
          getDraft={props.getDraft}
          onDraftChange={props.onDraftChange}
          onSend={props.onSend}
          onCycleEffort={props.onCycleEffort}
          onAddFiles={props.onAddFiles}
          onRemoveImage={props.onRemoveImage}
          onRemoveQueuedMessage={props.onRemoveQueuedMessage}
          onChooseDirectory={props.onChooseDirectory}
          toolbar={composerToolbar}
        /> : null}
      </div>

      {session.provider !== "claude" && session.detailsOpen ? (
        <Suspense fallback={<aside className="details-panel pane-details lazy-panel-loading" data-details-session={session.id} aria-busy="true">正在打开详情</aside>}>
          <DetailsPanel
            key={session.id}
            sessionId={session.id}
            title={session.title}
            activities={session.activities}
            compactionCount={session.compactionCount}
            detailView={session.detailView}
            onSelectView={props.onSetDetailView}
            goal={session.goal}
            plan={session.plan}
            subagents={session.subagents}
            capabilities={session.capabilities}
            working={session.status === "working"}
            readOnly={Boolean(session.readOnly)}
            onStartGoal={props.onStartGoal}
            onStopGoal={props.onStopGoal}
            dismissedNoticeKeys={dismissedNoticeKeys}
            onDismissNotice={dismissNotice}
          />
        </Suspense>
      ) : null}
    </section>
  );
}

export default memo(PaneView);
