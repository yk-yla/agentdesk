import { ArrowLeftRight, CircleDot, CornerDownRight, ListChecks, MoreHorizontal, PanelRight, Play, RefreshCw, Square, Target, X } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type DragEvent } from "react";
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
import TerminalPane from "./TerminalPane";
import type { ClaudeTerminalSettings } from "./terminalSettings";

const DetailsPanel = lazy(() => import("./DetailsPanel"));

const NO_VISIBLE_ACTIVITIES: Activity[] = [];
const NAVIGATION_BLOCKING_SELECTOR = '[aria-modal="true"], [role="menu"], .image-lightbox, .command-suggestions, .composer-more[open]';

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
  onSetCollaborationMode: (sessionId: string, mode: CollaborationMode) => void;
  onCompact: (sessionId: string) => void;
  onToggleDetails: (sessionId: string) => void;
  onSetDetailView: (sessionId: string, view: "activity" | "raw" | "goal" | "plan" | "agents") => void;
  onStartGoal: (sessionId: string, objective: string) => void;
  onStopGoal: (sessionId: string) => void;
  onClearError: (sessionId: string) => void;
  onRetryReadOnly: (sessionId: string) => void;
  onRespondApproval: (sessionId: string, result: JsonObject) => void;
  onInterrupt: (sessionId: string) => void;
  getDraft: (sessionId: string) => string;
  onDraftChange: (sessionId: string, value: string) => void;
  onSend: (sessionId: string, text: string, mode?: "submit" | "queue") => void;
  onCycleEffort: (sessionId: string, direction: 1 | -1) => void;
  onAddImages: (sessionId: string, files: File[]) => void;
  onRemoveImage: (sessionId: string, index: number) => void;
  onRemoveQueuedMessage: (sessionId: string, queuedId: string) => void;
  onChooseDirectory: (sessionId: string) => void;
  onModeChange: (sessionId: string, mode: "workbench" | "terminal") => void;
  onResumeTerminal: (sessionId: string) => void;
  onTerminalError: (sessionId: string, message: string) => void;
  onTerminalSettings: (sessionId: string, settings: ClaudeTerminalSettings) => void;
}

/**
 * 每个分栏一个 memo 组件：只有本分栏的会话变化才重渲染，
 * 不再因为输入、计时、侧栏搜索或其他分栏的事件而整体重建。
 */
function PaneView(props: PaneViewProps) {
  const { pane, session, models, attachments, bridge } = props;
  const conversationRef = useRef<HTMLDivElement>(null);
  const composerMoreRef = useRef<HTMLDetailsElement>(null);
  const followLatestRef = useRef(true);
  const questionNavigationScrollRef = useRef(false);
  const questionNavigationFrameRef = useRef<number | null>(null);
  const scrollStatesRef = useRef(new Map<string, { top: number; atBottom: boolean }>());
  const restoringSessionRef = useRef<string | null>(null);
  const previousPresentationModeRef = useRef(session.presentationMode);
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
  const emptySession = session.messages.length === 0 && visibleActivities.length === 0;
  const latestMessageLength = session.messages[session.messages.length - 1]?.text.length ?? 0;
  const latestActivityLength = session.activities[session.activities.length - 1]?.output?.length ?? 0;
  const activeGoal = session.goal?.status === "active" ? session.goal : null;

  const openGoalDetails = useCallback(() => {
    if (!session.detailsOpen) props.onToggleDetails(session.id);
    props.onSetDetailView(session.id, "goal");
  }, [props.onSetDetailView, props.onToggleDetails, session.detailsOpen, session.id]);

  useEffect(() => {
    const closeMoreMenuOnOutsideMouseDown = (event: MouseEvent) => {
      const details = composerMoreRef.current;
      const target = event.target;
      if (!details?.open || !(target instanceof Node) || details.contains(target)) return;
      details.removeAttribute("open");
    };
    window.addEventListener("mousedown", closeMoreMenuOnOutsideMouseDown);
    return () => window.removeEventListener("mousedown", closeMoreMenuOnOutsideMouseDown);
  }, []);

  useLayoutEffect(() => {
    const previousPresentationMode = previousPresentationModeRef.current;
    previousPresentationModeRef.current = session.presentationMode;
    const conversation = conversationRef.current;
    if (!conversation) return undefined;
    const returningFromTerminal = previousPresentationMode === "terminal" && session.presentationMode === "workbench";
    const saved = returningFromTerminal ? undefined : scrollStatesRef.current.get(session.id);
    const atBottom = returningFromTerminal || (saved?.atBottom ?? true);
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
  }, [session.id, session.presentationMode]);

  useLayoutEffect(() => {
    if (!followLatestRef.current) return undefined;
    const conversation = conversationRef.current;
    if (!conversation) return undefined;
    conversation.scrollTop = conversation.scrollHeight;
    scrollStatesRef.current.set(session.id, { top: conversation.scrollTop, atBottom: true });
    return undefined;
  }, [session.id, session.presentationMode, session.messages.length, latestMessageLength, session.activities.length, latestActivityLength]);

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

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    const tabId = event.dataTransfer.getData("text/tab");
    if (!tabId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const split = offsetX < rect.width * 0.22 ? "vertical" : offsetX > rect.width * 0.78 ? "vertical" : event.clientY - rect.top < rect.height * 0.2 ? "horizontal" : undefined;
    props.onMoveTab(tabId, pane.id, undefined, split);
  };

  const composerToolbar = useMemo(() => <div className="pane-controls">
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
    <button className={`detail-toggle ${session.detailsOpen ? "selected" : ""}`} onClick={() => props.onToggleDetails(session.id)} title="查看详情"><PanelRight size={15} /><span>详情</span></button>
    <details ref={composerMoreRef} className="composer-more">
      <summary title="更多会话操作" aria-label="更多会话操作"><MoreHorizontal size={16} /></summary>
      <div className="composer-more-menu">
        {session.capabilities.contextUsage !== "unsupported" ? <span className="composer-more-status">上下文 {formatCount(session.tokenUsage.used)}/{session.tokenUsage.total ? formatCount(session.tokenUsage.total) : "?"}</span> : null}
        <button type="button" disabled={session.readOnly} className={session.collaborationMode === "default" ? "selected" : ""} onClick={(event) => { props.onSetCollaborationMode(session.id, "default"); event.currentTarget.closest("details")?.removeAttribute("open"); }}><Play size={14} /><span>执行模式</span></button>
        {supports("plans") ? <button type="button" disabled={session.readOnly} className={session.collaborationMode === "plan" ? "selected" : ""} onClick={(event) => { props.onSetCollaborationMode(session.id, "plan"); event.currentTarget.closest("details")?.removeAttribute("open"); }}><ListChecks size={14} /><span>计划模式</span></button> : null}
        {session.capabilities.compact !== "unsupported" ? <button type="button" disabled={!supports("compact") || session.readOnly} onClick={(event) => { props.onCompact(session.id); event.currentTarget.closest("details")?.removeAttribute("open"); }}><RefreshCw size={14} /><span>压缩上下文 ({session.compactionCount})</span></button> : null}
        <button type="button" className={session.detailsOpen ? "selected" : ""} onClick={(event) => { props.onToggleDetails(session.id); event.currentTarget.closest("details")?.removeAttribute("open"); }}><PanelRight size={14} /><span>详情</span></button>
        {supports("goals") ? <button type="button" className={session.detailsOpen && session.detailView === "goal" ? "selected" : ""} onClick={(event) => { if (!session.detailsOpen) props.onToggleDetails(session.id); props.onSetDetailView(session.id, "goal"); event.currentTarget.closest("details")?.removeAttribute("open"); }}><Target size={14} /><span>目标</span></button> : null}
      </div>
    </details>
  </div>, [
    claudeModelLabel, efforts, model?.displayName, models, props.onCompact, props.onSetCollaborationMode, props.onSetDetailView,
    props.onSetSessionSetting, props.onToggleDetails, session.collaborationMode,
    session.compactionCount, session.detailView, session.detailsOpen, session.effort, session.id, session.model, session.provider, session.readOnly,
    session.resolvedModel,
    session.tokenUsage.total, session.tokenUsage.used,
  ]);

  if (session.presentationMode === "terminal") {
    return (
      <section
        className={`main-panel pane-panel terminal-pane-panel${props.isActivePane ? " active-pane" : ""}${props.isActiveTab ? "" : " inactive-tab"}`}
        aria-hidden={!props.isActiveTab}
        onMouseDown={() => props.onFocusPane(pane.id)}
      >
        <TerminalPane
          key={session.id}
          session={session}
          bridge={bridge}
          isActive={props.isActivePane}
          onModeChange={(mode) => props.onModeChange(session.id, mode)}
          onResume={() => props.onResumeTerminal(session.id)}
          onError={(message) => props.onTerminalError(session.id, message)}
          onSettings={(settings) => props.onTerminalSettings(session.id, settings)}
        />
      </section>
    );
  }

  return (
    <section
      className={`main-panel pane-panel ${props.isActivePane ? "active-pane" : ""}${emptySession ? " empty-pane" : ""}${props.isActiveTab ? "" : " inactive-tab"}`}
      aria-hidden={!props.isActiveTab}
      onMouseDown={() => props.onFocusPane(pane.id)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
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
        />
        {session.historyLoading ? <div className="history-loading-overlay" role="status" aria-busy="true">
          <RefreshCw className="history-loading-icon spin" size={16} />
          <span>正在读取会话记录…</span>
        </div> : null}
      </div>

      {session.provider !== "claude" && <button
        className="presentation-toggle workbench-presentation-toggle"
        onClick={() => props.onModeChange(session.id, "terminal")}
        title="切换到黑窗口"
        aria-label="切换到黑窗口"
        disabled={session.status === "error" && !session.threadId}
      ><ArrowLeftRight size={16} /></button>}

      <div className="composer-area">
        {session.readOnly ? <div className="read-only-banner" role="status"><CircleDot size={15} /><span>该会话正被其他程序使用，当前为只读模式。</span><button type="button" onClick={() => props.onToggleDetails(session.id)}>{session.detailsOpen ? "关闭详情" : "查看详情"}</button><button type="button" onClick={() => props.onRetryReadOnly(session.id)}>重新尝试编辑</button></div> : null}
        {!session.readOnly && session.errorText ? <div className="error-banner" role="alert"><CircleDot size={15} /><span>{session.errorText}</span><button className="bare-button" onClick={() => props.onClearError(session.id)} title="关闭" aria-label="关闭错误提示"><X size={14} /></button></div> : null}
        {session.pendingApprovals[0] && !session.readOnly ? <div className="server-request-wrap"><ServerRequestPanel key={`${session.pendingApprovals[0].requestId}:${session.pendingApprovals[0].interactionId || ""}:${session.pendingApprovals[0].queryGeneration || 0}`} request={session.pendingApprovals[0]} bridge={bridge} onRespond={(result) => props.onRespondApproval(session.id, result)} />{session.pendingApprovals.length > 1 ? <span className="server-request-count">另有 {session.pendingApprovals.length - 1} 个请求等待处理</span> : null}</div> : null}
        {session.goal ? <GoalExecutionStrip
          goal={session.goal}
          working={session.status === "working"}
          readOnly={Boolean(session.readOnly)}
          stage={session.retryState ? `正在重试，第 ${session.retryState.attempt} 次：${session.retryState.message}` : session.statusLabel}
          onOpenDetails={openGoalDetails}
          onStop={() => props.onStopGoal(session.id)}
        /> : null}
        {session.status === "working" && !activeGoal ? <div className={`working-strip${session.retryState ? " retrying" : ""}${session.readOnly ? " read-only-working" : ""}`}>{session.retryState && !session.readOnly ? <RefreshCw className="retry-icon spin" size={14} /> : <span className="working-dot" />}<div className="working-copy"><span>{session.readOnly ? "其他程序正在执行此会话" : session.retryState ? `正在重试… 第 ${session.retryState.attempt} 次` : session.statusLabel}{!session.readOnly ? <> (<ElapsedTimer startedAt={session.startedAt} /> · Esc 停止)</> : null}</span></div>{!session.readOnly ? <button className="stop-button" onClick={() => props.onInterrupt(session.id)} title="停止任务"><Square size={13} fill="currentColor" /><span>停止</span></button> : null}{session.retryState && !session.readOnly ? <span className="retry-detail"><CornerDownRight size={12} />{session.retryState.message}{session.retryState.additionalDetails ? `：${session.retryState.additionalDetails}` : ""}</span> : null}</div> : null}
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
          placeholder={activeGoal ? "可继续补充指令或询问目标进度" : undefined}
          copyImage={bridge.copyImage}
          getDraft={props.getDraft}
          onDraftChange={props.onDraftChange}
          onSend={props.onSend}
          onCycleEffort={props.onCycleEffort}
          onAddImages={props.onAddImages}
          onRemoveImage={props.onRemoveImage}
          onRemoveQueuedMessage={props.onRemoveQueuedMessage}
          onChooseDirectory={props.onChooseDirectory}
          toolbar={composerToolbar}
        /> : null}
      </div>

      {session.detailsOpen ? (
        <Suspense fallback={<aside className="details-panel pane-details lazy-panel-loading" aria-busy="true">正在打开详情</aside>}>
          <DetailsPanel
            key={session.id}
            sessionId={session.id}
            title={session.title}
            activities={session.activities}
            compactionCount={session.compactionCount}
            detailView={session.detailView}
            onClose={props.onToggleDetails}
            onSelectView={props.onSetDetailView}
            goal={session.goal}
            plan={session.plan}
            subagents={session.subagents}
            capabilities={session.capabilities}
            working={session.status === "working"}
            readOnly={Boolean(session.readOnly)}
            onStartGoal={props.onStartGoal}
            onStopGoal={props.onStopGoal}
          />
        </Suspense>
      ) : null}
    </section>
  );
}

export default memo(PaneView);
