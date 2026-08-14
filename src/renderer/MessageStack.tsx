import { Check, FolderOpen, Copy } from "lucide-react";
import { Fragment, lazy, memo, Suspense, useMemo, useState } from "react";
import type { AgentBridge, DisplayMode } from "../shared/protocol";
import type { AgentProvider } from "../shared/agentProtocol";
import ActivityIcon from "./ActivityIcon";
import ActivityOutput from "./ActivityOutput";
import { basename, type Activity, type Message } from "./domain";
import { formatMessageTimestamp, getMessageTimeDivider } from "./messageTimestamp";

const MarkdownMessage = lazy(() => import("./MarkdownMessage"));

const MESSAGE_WINDOW = 200;
const ACTIVITY_WINDOW = 100;
const EMPTY_IMAGES: Message["images"] = [];

interface Props {
  messages: Message[];
  visibleActivities: Activity[];
  displayMode: DisplayMode;
  bridge: AgentBridge;
  cwd: string;
  provider: AgentProvider;
}

interface MessageItemProps {
  message: Message;
  bridge: AgentBridge;
  provider: AgentProvider;
}

function MessageItem({ message, bridge, provider }: MessageItemProps) {
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
      className={`message-row ${message.role}`}
      aria-label={message.role === "user" ? "你的消息" : message.role === "assistant" ? `${provider === "codex" ? "Codex" : "Claude Code"} 消息` : "系统消息"}
      data-user-message-anchor={message.role === "user" ? "" : undefined}
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
              readLocalImage={bridge.readLocalImage}
              copyImage={bridge.copyImage}
              openLocalPath={bridge.openLocalPath}
              openExternal={bridge.openExternal}
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
function MessageStackBase({ messages, visibleActivities, displayMode, bridge, cwd, provider }: Props) {
  const [visibleCount, setVisibleCount] = useState(MESSAGE_WINDOW);
  const [activityWindow, setActivityWindow] = useState({ mode: displayMode, count: ACTIVITY_WINDOW });
  const visibleActivityCount = activityWindow.mode === displayMode ? activityWindow.count : ACTIVITY_WINDOW;
  const shown = useMemo(
    () => (messages.length > visibleCount ? messages.slice(messages.length - visibleCount) : messages),
    [messages, visibleCount],
  );
  const shownActivities = useMemo(
    () => (visibleActivities.length > visibleActivityCount ? visibleActivities.slice(visibleActivities.length - visibleActivityCount) : visibleActivities),
    [visibleActivities, visibleActivityCount],
  );

  if (!messages.length && !visibleActivities.length) {
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
  const hiddenActivities = visibleActivities.length - shownActivities.length;
  return (
    <div className="message-stack">
      {hidden > 0 ? <button className="history-more" data-load-earlier-messages onClick={() => setVisibleCount((count) => count + MESSAGE_WINDOW)}>加载更早消息 · 剩余 {hidden}</button> : null}
      {shown.map((message, index) => {
        const divider = getMessageTimeDivider(message.timestamp, shown[index - 1]?.timestamp);
        return (
          <Fragment key={`${message.id}:${index}`}>
            {divider ? <div className={`message-time-divider ${divider.kind}`}><span>{divider.label}</span></div> : null}
            <MemoMessageItem message={message} bridge={bridge} provider={provider} />
          </Fragment>
        );
      })}
      {hiddenActivities > 0 ? <button className="history-more" onClick={() => setActivityWindow({ mode: displayMode, count: visibleActivityCount + ACTIVITY_WINDOW })}>加载更早活动 · 剩余 {hiddenActivities}</button> : null}
      {shownActivities.map((activity, index) => (
        <article className={`visible-activity ${activity.status}`} key={`visible-${activity.id}:${index}`}>
          <ActivityIcon kind={activity.kind} status={activity.status} />
          <div>
            <strong>{activity.title}</strong>
            <span>{activity.detail}</span>
            {displayMode === "full" ? <ActivityOutput output={activity.output || ""} variant="main" /> : null}
          </div>
        </article>
      ))}
    </div>
  );
}

export default memo(MessageStackBase);
