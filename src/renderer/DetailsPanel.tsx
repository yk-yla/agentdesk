import { Bot, CircleDot, ListChecks, Target, X } from "lucide-react";
import { memo, useMemo, useState } from "react";
import ActivityIcon from "./ActivityIcon";
import ActivityOutput from "./ActivityOutput";
import type { Activity, SessionGoal, SessionPlan, SubagentState } from "./domain";
import type { AgentCapabilities } from "../shared/agentProtocol";
import GoalPanel from "./GoalPanel";
import PlanPanel from "./PlanPanel";
import RawEventList from "./RawEventList";
import SubagentPanel from "./SubagentPanel";
import { formatEventTimestamp } from "./messageTimestamp";

const ACTIVITY_PAGE = 200;

const STATUS_LABEL: Record<Activity["status"], string> = {
  inProgress: "进行中",
  failed: "失败",
  declined: "已拒绝",
  interrupted: "已中断",
  completed: "完成",
};

function activityDismissKey(activity: Activity) {
  return `${activity.id}:${activity.status}:${activity.timestamp || 0}`;
}

interface Props {
  sessionId: string;
  title: string;
  activities: Activity[];
  goal: SessionGoal | null;
  plan: SessionPlan | null;
  subagents: SubagentState[];
  compactionCount: number;
  capabilities: AgentCapabilities;
  detailView: "activity" | "raw" | "goal" | "plan" | "agents";
  onClose: (sessionId: string) => void;
  onSelectView: (sessionId: string, view: "activity" | "raw" | "goal" | "plan" | "agents") => void;
  working: boolean;
  readOnly: boolean;
  onStartGoal: (sessionId: string, objective: string) => void;
  onStopGoal: (sessionId: string) => void;
}

function DetailsPanelBase({ sessionId, title, activities, goal, plan, subagents, compactionCount, capabilities, detailView, working, readOnly, onClose, onSelectView, onStartGoal, onStopGoal }: Props) {
  const [visibleCount, setVisibleCount] = useState(ACTIVITY_PAGE);
  const [dismissedActivityKeys, setDismissedActivityKeys] = useState<Set<string>>(() => new Set());
  const visibleActivities = useMemo(() => activities.filter((activity) => !dismissedActivityKeys.has(activityDismissKey(activity))), [activities, dismissedActivityKeys]);
  const shownActivities = useMemo(
    () => (visibleActivities.length > visibleCount ? visibleActivities.slice(visibleActivities.length - visibleCount) : visibleActivities),
    [visibleActivities, visibleCount],
  );
  const hiddenCount = visibleActivities.length - shownActivities.length;

  return (
    <aside className="details-panel pane-details">
      <div className="details-header">
        <div><span className="context-kicker">THREAD DETAIL</span><h2>{title}</h2></div>
        <button className="icon-button" onClick={() => onClose(sessionId)} title="关闭详情" aria-label="关闭详情"><X size={17} /></button>
      </div>
      <div className="details-tabs">
        <button className={detailView === "activity" ? "active" : ""} onClick={() => onSelectView(sessionId, "activity")}>活动</button>
        {capabilities.plans === "supported" ? <button className={detailView === "plan" ? "active" : ""} onClick={() => onSelectView(sessionId, "plan")}><ListChecks size={11} />计划</button> : null}
        {capabilities.subagents === "supported" ? <button className={detailView === "agents" ? "active" : ""} onClick={() => onSelectView(sessionId, "agents")}><Bot size={11} />Agent</button> : null}
        {capabilities.goals === "supported" ? <button className={detailView === "goal" ? "active" : ""} onClick={() => onSelectView(sessionId, "goal")}><Target size={11} />目标</button> : null}
        <button className={detailView === "raw" ? "active" : ""} onClick={() => onSelectView(sessionId, "raw")}>原始事件</button>
      </div>
      <div className="details-scroll">
        {detailView === "goal" ? <GoalPanel goal={goal} working={working} readOnly={readOnly} onStart={(objective) => onStartGoal(sessionId, objective)} onStop={() => onStopGoal(sessionId)} />
          : detailView === "plan" ? <PlanPanel plan={plan} />
          : detailView === "agents" ? <SubagentPanel subagents={subagents} />
          : detailView === "activity"
          ? (visibleActivities.length
            ? <>
              {hiddenCount > 0 ? <button className="history-more" onClick={() => setVisibleCount((count) => count + ACTIVITY_PAGE)}>加载更早活动 · 剩余 {hiddenCount}</button> : null}
              {shownActivities.map((activity, index) => <div className={`activity-item ${activity.status}`} key={`${activity.id}:${index}`}>
                <div className="activity-icon"><ActivityIcon kind={activity.kind} status={activity.status} /></div>
                <div className="activity-body">
                  <div className="activity-title"><span>{activity.title}</span><span className="activity-meta">{formatEventTimestamp(activity.timestamp) ? <time dateTime={new Date(activity.timestamp!).toISOString()}>{formatEventTimestamp(activity.timestamp)}</time> : null}<span className="activity-status">{STATUS_LABEL[activity.status]}</span></span></div>
                  <code>{activity.detail}</code>
                  <ActivityOutput output={activity.output || ""} variant="detail" />
                </div>
                {activity.status === "failed" || activity.status === "declined" || activity.status === "interrupted" ? <button type="button" className="bare-button activity-dismiss" onClick={() => setDismissedActivityKeys((current) => { const next = new Set(current); next.add(activityDismissKey(activity)); return next; })} title="关闭错误提示" aria-label="关闭错误提示"><X size={13} /></button> : null}
              </div>)}
            </>
            : <div className="details-empty">暂无活动</div>)
          : <><div className="details-view-hint">原始事件是 Codex 返回的完整底层记录，主要用于排查问题；活动页展示的是整理后的摘要。</div><RawEventList sessionId={sessionId} variant="detail" /></>}
      </div>
      <div className="details-footer"><span><CircleDot size={13} /> 原始事件保留 · 压缩 {compactionCount} 轮</span></div>
    </aside>
  );
}

export default memo(DetailsPanelBase);
