import { memo, useMemo, useState } from "react";
import { rawEventText, useRawEvents } from "./rawEventStore";

const PAGE_SIZE = 100;

interface Props {
  sessionId: string;
  /** inline 用于主对话流的原始模式，detail 用于详情面板（最新在上）。 */
  variant: "inline" | "detail";
}

/**
 * 原始事件全量保留在 rawEventStore 里，这里只渲染最近一页。
 * 事件本身不会丢，"加载更早"可以一直翻到第一条。
 */
function RawEventListBase({ sessionId, variant }: Props) {
  const events = useRawEvents(sessionId);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const shown = useMemo(() => {
    const slice = events.slice(Math.max(0, events.length - visibleCount));
    return variant === "detail" ? slice.reverse() : slice;
  }, [events, visibleCount, variant]);

  if (!events.length) {
    return variant === "detail" ? <div className="details-empty">等待 app-server 事件</div> : null;
  }

  const remaining = events.length - shown.length;
  const className = variant === "detail" ? "raw-event" : "inline-raw";
  const moreButton = remaining > 0
    ? <button className="history-more" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>加载更早事件 · 剩余 {remaining}</button>
    : null;

  return <>
    {variant === "inline" ? moreButton : null}
    {shown.map((event) => <div className={className} key={event.id}><strong>{event.label}</strong><code>{rawEventText(event)}</code></div>)}
    {variant === "detail" ? moreButton : null}
  </>;
}

export default memo(RawEventListBase);
