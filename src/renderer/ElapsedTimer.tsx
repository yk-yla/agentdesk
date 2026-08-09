import { memo, useEffect, useState } from "react";
import { formatElapsed } from "./domain";

/**
 * 计时状态由组件自己持有。
 * 原来顶层每秒 setNow 会重渲染整个应用；而且那个 Effect 依赖整个 sessions，
 * 流式期间事件比 1 秒更密，interval 会被反复重建，导致运行时长根本不走。
 */
function ElapsedTimerBase({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <>{formatElapsed(startedAt, now)}</>;
}

export default memo(ElapsedTimerBase);
