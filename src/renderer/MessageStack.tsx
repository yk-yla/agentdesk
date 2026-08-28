import { Check, ChevronDown, FolderOpen, Copy, RefreshCw, X } from "lucide-react";
import { Fragment, lazy, memo, Suspense, useEffect, useMemo, useState } from "react";
import type { AgentBridge } from "../shared/protocol";
import type { AgentProvider } from "../shared/agentProtocol";
import ActivityIcon from "./ActivityIcon";
import { basename, type Activity, type Message } from "./domain";
import { formatMessageTimestamp, getMessageTimeDivider } from "./messageTimestamp";
import { activityNoticeKey, isActivityNoticeDismissed } from "./sessionNoticeDismissal";

const MarkdownMessage = lazy(() => import("./MarkdownMessage"));

const MESSAGE_WINDOW = 200;
const ACTIVITY_WINDOW = 100;
const EMPTY_IMAGES: Message["images"] = [];
const ACTIVITY_GROUP_LABELS: Record<Activity["kind"], string> = {
  commandExecution: "命令执行",
  fileChange: "文件修改",
  mcpToolCall: "工具调用",
  plan: "计划更新",
  reasoning: "分析活动",
  subAgent: "子 Agent 活动",
  other: "后台活动",
};

interface Props {
  messages: Message[];
  visibleActivities: Activity[];
  bridge: AgentBridge;
  cwd: string;
  provider: AgentProvider;
  searchTerm?: string;
  activeSearchMessageId?: string | null;
  activeSearchOccurrence?: number | null;
  searchTargetMessageIndex?: number | null;
  canLoadEarlier?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  dismissedNoticeKeys: ReadonlySet<string>;
  onDismissNotice: (noticeKey: string) => void;
  onDismissNotices: (noticeKeys: readonly string[]) => void;
}

interface MessageItemProps {
  message: Message;
  bridge: AgentBridge;
  provider: AgentProvider;
  cwd: string;
  searchTerm: string;
  searchActive: boolean;
  searchOccurrence: number | null;
}

function MessageItem({ message, bridge, provider, cwd, searchTerm, searchActive, searchOccurrence }: MessageItemProps) {
  const [copied, setCopied] = useState(false);
  const formattedTimestamp = formatMessageTimestamp(message.timestamp || 0);
  const showToolbar = message.role !== "system" && Boolean(formattedTimestamp);

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article
      className={`message-row ${message.role}${searchActive ? " search-active" : ""}`}
      aria-label={message.role === "user" ? "你的消息" : message.role === "assistant" ? `${provider === "codex" ? "Codex" : "Claude Code"} 消息` : "系统消息"}
      data-user-message-anchor={message.role === "user" ? "" : undefined}
      data-search-active={searchActive ? "true" : undefined}
    >
      <div className="message-content">
        {showToolbar ? (
          <div className="message-toolbar">
            <time className="message-timestamp" dateTime={new Date(message.timestamp || 0).toISOString()}>{formattedTimestamp}</time>
            <button
              type="button"
              className="message-copy-button"
              onClick={() => void copyMessage()}
              title={copied ? "已复制" : "复制消息"}
              aria-label={copied ? "已复制" : "复制消息"}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
        ) : null}
        <div className="message-text">
          <Suspense fallback={<span className="markdown-loading" aria-busy="true">正在加载消息</span>}>
            <MarkdownMessage
              text={message.text}
              images={message.images || EMPTY_IMAGES}
              streaming={message.streaming}
              searchTerm={searchTerm}
              activeSearchOccurrence={searchOccurrence}
              readLocalImage={bridge.readLocalImage}
              copyImage={bridge.copyImage}
              openLocalPath={bridge.openLocalPath}
              openExternal={bridge.openExternal}
              cwd={cwd}
            />
          </Suspense>
          {message.streaming ? <span className="stream-caret" /> : null}
        </div>
      </div>
    </article>
  );
}

const MemoMessageItem = memo(MessageItem);

/**
 * 只渲染最近一段消息，历史更早的部分按需展开。
 * 长会话首次挂载不再一次性解析全部 Markdown。
 */
function MessageStackBase({ messages, visibleActivities, bridge, cwd, provider, searchTerm = "", activeSearchMessageId = null, activeSearchOccurrence = null, searchTargetMessageIndex = null, canLoadEarlier = false, loadingEarlier = false, onLoadEarlier, dismissedNoticeKeys, onDismissNotice, onDismissNotices }: Props) {
  const [visibleCount, setVisibleCount] = useState(MESSAGE_WINDOW);
  const [visibleActivityCount, setVisibleActivityCount] = useState(ACTIVITY_WINDOW);
  const [activityGroupExpanded, setActivityGroupExpanded] = useState(false);
  const normalizedSearchTerm = searchTerm.trim().toLocaleLowerCase();

  useEffect(() => {
    if (!normalizedSearchTerm || searchTargetMessageIndex === null || searchTargetMessageIndex === undefined) return;
    const firstShownIndex = messages.length - visibleCount;
    if (searchTargetMessageIndex < firstShownIndex) {
      setVisibleCount(Math.max(MESSAGE_WINDOW, messages.length - searchTargetMessageIndex));
    }
  }, [messages.length, normalizedSearchTerm, searchTargetMessageIndex, visibleCount]);
  const shown = useMemo(
    () => (messages.length > visibleCount ? messages.slice(messages.length - visibleCount) : messages),
    [messages, visibleCount],
  );
  const activeActivities = useMemo(
    () => visibleActivities.filter((activity) => !isActivityNoticeDismissed(activity, dismissedNoticeKeys)),
    [dismissedNoticeKeys, visibleActivities],
  );
  const shownActivities = useMemo(
    () => (activeActivities.length > visibleActivityCount ? activeActivities.slice(activeActivities.length - visibleActivityCount) : activeActivities),
    [activeActivities, visibleActivityCount],
  );

  if (!messages.length && !activeActivities.length) {
    return (
      <div className="welcome-state">
        <div className="welcome-heading">
          <img className="welcome-icon" src="./app-icon.png" alt="" />
          <div className="welcome-heading-copy">
            <span className="welcome-kicker">新会话</span>
            <h1>今天想完成什么？</h1>
          </div>
        </div>
        <div className="welcome-workspace" title={cwd}>
          <FolderOpen size={14} />
          <span>当前工作区</span>
          <strong>{basename(cwd)}</strong>
          <code>{cwd}</code>
        </div>
      </div>
    );
  }

  const hidden = messages.length - shown.length;
  const hiddenActivities = activeActivities.length - shownActivities.length;
  const groupedActivityTitle = activeActivities.length > 1 && activeActivities.every((activity) => activity.kind === activeActivities[0]?.kind)
    ? `${activeActivities.length} 条${ACTIVITY_GROUP_LABELS[activeActivities[0].kind]}`
    : `${activeActivities.length} 条活动提示`;
  const groupedActivityStatus = [
    ["failed", "失败"],
    ["declined", "已拒绝"],
    ["interrupted", "已中断"],
  ].map(([status, label]) => {
    const count = activeActivities.filter((activity) => activity.status === status).length;
    return count ? `${count} 条${label}` : "";
  }).filter(Boolean).join(" · ");
  const activeActivityNoticeKeys = activeActivities.map(activityNoticeKey);
  return (
    <div className="message-stack">
      {hidden > 0 ? <button className="history-more" data-load-earlier-messages onClick={() => setVisibleCount((count) => count + MESSAGE_WINDOW)}>加载已读取的更早消息 · 剩余 {hidden}</button>
        : canLoadEarlier && onLoadEarlier ? <button className="history-more" data-load-earlier-messages disabled={loadingEarlier} onClick={onLoadEarlier}>{loadingEarlier ? <RefreshCw className="spin" size={13} /> : null}{loadingEarlier ? "正在读取更早消息" : "加载更早消息"}</button> : null}
      {shown.map((message, index) => {
        const divider = getMessageTimeDivider(message.timestamp, shown[index - 1]?.timestamp);
        return (
          <Fragment key={`${message.id}:${index}`}>
            {divider ? <div className={`message-time-divider ${divider.kind}`}><span>{divider.label}</span></div> : null}
        <MemoMessageItem
          message={message}
          bridge={bridge}
          provider={provider}
          cwd={cwd}
          searchTerm={normalizedSearchTerm && message.text.toLocaleLowerCase().includes(normalizedSearchTerm) ? normalizedSearchTerm : ""}
          searchActive={message.id === activeSearchMessageId}
          searchOccurrence={message.id === activeSearchMessageId ? activeSearchOccurrence : null}
        />
          </Fragment>
        );
      })}
      {activeActivities.length > 1 ? <section className="visible-activity-group" aria-label={groupedActivityTitle}>
        <div className="visible-activity-group-header">
          <ActivityIcon kind={shownActivities[0].kind} status={shownActivities[0].status} />
          <button
            type="button"
            className="visible-activity-group-toggle"
            aria-expanded={activityGroupExpanded}
            onClick={() => setActivityGroupExpanded((expanded) => !expanded)}
            title={activityGroupExpanded ? "收起活动提示" : "展开活动提示"}
          >
            <span className="visible-activity-group-copy"><strong>{groupedActivityTitle}</strong><span>{groupedActivityStatus}</span></span>
            <ChevronDown className="visible-activity-group-chevron" size={15} />
          </button>
          <button type="button" className="bare-button visible-activity-dismiss" onClick={() => onDismissNotices(activeActivityNoticeKeys)} title="关闭全部活动提示" aria-label="关闭全部活动提示"><X size={14} /></button>
        </div>
        {activityGroupExpanded ? <div className="visible-activity-group-list">
          {shownActivities.map((activity, index) => <article className={`visible-activity-group-item ${activity.status}`} key={`visible-group-${activity.id}:${index}`}>
            <ActivityIcon kind={activity.kind} status={activity.status} />
            <div className="visible-activity-content"><strong>{activity.title}</strong><span>{activity.detail}</span></div>
            <button type="button" className="bare-button visible-activity-dismiss" onClick={() => onDismissNotice(activityNoticeKey(activity))} title="关闭这条活动提示" aria-label="关闭这条活动提示"><X size={14} /></button>
          </article>)}
          {hiddenActivities > 0 ? <button className="history-more" onClick={() => setVisibleActivityCount((count) => count + ACTIVITY_WINDOW)}>加载更早活动 · 剩余 {hiddenActivities}</button> : null}
        </div> : null}
      </section> : shownActivities.map((activity, index) => (
        <article className={`visible-activity ${activity.status}`} key={`visible-${activity.id}:${index}`}>
          <ActivityIcon kind={activity.kind} status={activity.status} />
          <div className="visible-activity-content">
            <strong>{activity.title}</strong>
            <span>{activity.detail}</span>
          </div>
          <button type="button" className="bare-button visible-activity-dismiss" onClick={() => onDismissNotice(activityNoticeKey(activity))} title="关闭活动提示" aria-label="关闭活动提示"><X size={14} /></button>
        </article>
      ))}
    </div>
  );
}

export default memo(MessageStackBase);
