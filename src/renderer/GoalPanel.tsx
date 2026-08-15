import { CircleStop, Play, Target } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { GoalStatus, SessionGoal } from "./domain";

interface Props {
  goal: SessionGoal | null;
  working: boolean;
  readOnly: boolean;
  onStart: (objective: string) => void;
  onStop: () => void;
}

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: "进行中", paused: "已停止", blocked: "暂时受阻", usageLimited: "额度不足", budgetLimited: "预算已用尽", complete: "已完成",
};

const STATUS_HINT: Record<GoalStatus, string> = {
  active: "Codex 正在持续推进这个目标。",
  paused: "目标已停止，点击开始可以继续。",
  blocked: "Codex 暂时无法继续，详情请看主对话或原始事件。",
  usageLimited: "Codex 当前额度不足，恢复后可以继续。",
  budgetLimited: "这个目标的预算已用尽。当前界面不设置预算上限。",
  complete: "Codex 已判断这个目标完成。",
};

function GoalPanel({ goal, working, readOnly, onStart, onStop }: Props) {
  const [objective, setObjective] = useState(goal?.objective || "");

  useEffect(() => {
    setObjective(goal?.objective || "");
  }, [goal]);

  const start = () => {
    const text = objective.trim();
    if (!text || working) return;
    onStart(text);
  };

  return (
    <div className="goal-panel">
      <div className="goal-panel-heading"><Target size={17} /><div><strong>持续目标</strong><span>输入目标后开始，Codex 会持续执行直到完成。</span></div></div>
      <label className="goal-field"><span>目标</span><textarea value={objective} disabled={readOnly} onChange={(event) => setObjective(event.target.value)} placeholder="例如：完成迁移并通过构建和回归检查" rows={4} /></label>
      {goal ? <>
        <div className={`goal-status ${goal.status}`}><strong>{STATUS_LABEL[goal.status]}</strong><span>{STATUS_HINT[goal.status]}</span></div>
        <div className="goal-metrics"><span>已用 {goal.tokensUsed.toLocaleString()} tokens</span><span>运行 {Math.floor(goal.timeUsedSeconds / 60)}m {goal.timeUsedSeconds % 60}s</span></div>
      </> : <p className="goal-hint">开始后，Codex 会持续推进这个目标。</p>}
      <div className="goal-actions">
        <button className="request-button primary" disabled={!objective.trim() || working || readOnly} onClick={start}><Play size={13} />{goal?.status === "complete" ? "重新开始" : goal ? "继续" : "开始"}</button>
        {goal?.status === "active" ? <button className="request-button secondary danger-button" disabled={readOnly} onClick={onStop}><CircleStop size={13} />停止</button> : null}
      </div>
    </div>
  );
}

export default memo(GoalPanel);
