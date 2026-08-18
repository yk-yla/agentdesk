import { memo, useEffect, useMemo, useState } from "react";
import { Square, Target } from "lucide-react";
import { formatCount, type GoalStatus, type SessionGoal } from "./domain";

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: "目标执行中",
  paused: "目标已停止",
  blocked: "目标暂时受阻",
  usageLimited: "目标额度不足",
  budgetLimited: "目标预算已用尽",
  complete: "目标已完成",
};

const IDLE_STAGE: Record<GoalStatus, string> = {
  active: "等待继续推进",
  paused: "可以从目标详情中继续",
  blocked: "需要处理阻碍后继续",
  usageLimited: "恢复可用额度后继续",
  budgetLimited: "需要调整预算后继续",
  complete: "目标已经完成",
};

interface Props {
  goal: SessionGoal;
  working: boolean;
  readOnly: boolean;
  stage: string;
  onOpenDetails: () => void;
  onStop: () => void;
}

function timestampMilliseconds(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function formatGoalDuration(value: number) {
  const totalSeconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}小时${minutes}分${seconds}秒`;
  if (minutes) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

function GoalElapsed({ goal }: { goal: SessionGoal }) {
  const active = goal.status === "active";
  const [now, setNow] = useState(() => Date.now());
  const updatedAt = timestampMilliseconds(goal.updatedAt);

  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, updatedAt]);

  const elapsedSinceUpdate = active && updatedAt ? Math.max(0, Math.floor((now - updatedAt) / 1000)) : 0;
  return <>{formatGoalDuration(goal.timeUsedSeconds + elapsedSinceUpdate)}</>;
}

function GoalExecutionStripBase({ goal, working, readOnly, stage, onOpenDetails, onStop }: Props) {
  const active = goal.status === "active";
  const stageLabel = useMemo(() => {
    if (readOnly && working) return "其他程序正在执行此会话";
    if (working && stage && stage !== "工作中") return stage;
    return working ? "正在持续推进目标" : IDLE_STAGE[goal.status];
  }, [goal.status, readOnly, stage, working]);

  return (
    <section className={`goal-execution-strip ${goal.status}`} aria-live="polite">
      <div className="goal-execution-main">
        <span className="goal-execution-icon" aria-hidden="true"><Target size={16} /></span>
        <button type="button" className="goal-execution-summary" onClick={onOpenDetails} title="打开目标详情">
          <strong>{STATUS_LABEL[goal.status]}</strong>
          <span title={goal.objective}>{goal.objective}</span>
        </button>
        <span className="goal-execution-time">已运行 <GoalElapsed goal={goal} /></span>
        {active && !readOnly ? <button type="button" className="goal-execution-stop" onClick={onStop} title="停止目标"><Square size={11} fill="currentColor" /><span>停止</span></button> : null}
      </div>
      <div className="goal-execution-meta">
        <span className="goal-execution-stage" title={stageLabel}>当前阶段：{stageLabel}</span>
        <span>已用 {formatCount(goal.tokensUsed)} tokens</span>
      </div>
      {active ? <span className="goal-execution-progress" aria-hidden="true"><span /></span> : null}
    </section>
  );
}

export default memo(GoalExecutionStripBase);
