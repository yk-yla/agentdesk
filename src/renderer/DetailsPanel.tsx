import { Bot, CircleDot, ListChecks, Target, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import ActivityIcon from "./ActivityIcon";
import ActivityOutput from "./ActivityOutput";
import type { Activity, SessionGoal, SessionPlan, SubagentState } from "./domain";
import type { AgentCapabilities } from "../shared/agentProtocol";
import GoalPanel from "./GoalPanel";
import PlanPanel from "./PlanPanel";
import SubagentPanel from "./SubagentPanel";
import { formatEventTimestamp } from "./messageTimestamp";
import { activityNoticeKey, isActivityNoticeDismissed, isActivityNoticeDismissible } from "./sessionNoticeDismissal";

const ACTIVITY_INITIAL_COUNT = 20;
const ACTIVITY_LOAD_COUNT = 10;

const STATUS_LABEL: Record<Activity["status"], string> = {
  inProgress: "进行中",
  failed: "失败",
  declined: "已拒绝",
  interrupted: "已中断",
  completed: "完成",
};

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
  onSelectView: (sessionId: string, view: "activity" | "raw" | "goal" | "plan" | "agents") => void;
  working: boolean;
  readOnly: boolean;
  onStartGoal: (sessionId: string, objective: string) => void;
  onStopGoal: (sessionId: string) => void;
  dismissedNoticeKeys: ReadonlySet<string>;
  onDismissNotice: (noticeKey: string) => void;
}

function DetailsPanelBase({ sessionId, title, activities, goal, plan, subagents, compactionCount, capabilities, detailView, working, readOnly, onSelectView, onStartGoal, onStopGoal, dismissedNoticeKeys, onDismissNotice }: Props) {
  const [visibleCount, setVisibleCount] = useState(ACTIVITY_INITIAL_COUNT);
  const detailsScrollRef = useRef<HTMLDivElement>(null);
  const visibleActivities = useMemo(() => activities.filter((activity) => !isActivityNoticeDismissed(activity, dismissedNoticeKeys)), [activities, dismissedNoticeKeys]);
  const shownActivities = useMemo(
    () => (visibleActivities.length > visibleCount ? visibleActivities.slice(visibleActivities.length - visibleCount) : visibleActivities).slice().reverse(),
    [visibleActivities, visibleCount],
  );
  const hiddenCount = visibleActivities.length - shownActivities.length;
  const activeDetailView = detailView === "raw" ? "activity" : detailView;

  useEffect(() => {
    if (activeDetailView !== "activity") return undefined;
    const scrollContainer = detailsScrollRef.current;
    if (!scrollContainer) return undefined;
    const loadWhenNearBottom = () => {
      if (visibleCount >= visibleActivities.length) return;
      const distanceToBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
      if (distanceToBottom <= 96) setVisibleCount((count) => Math.min(count + ACTIVITY_LOAD_COUNT, visibleActivities.length));
    };
    scrollContainer.addEventListener("scroll", loadWhenNearBottom, { passive: true });
    loadWhenNearBottom();
    return () => scrollContainer.removeEventListener("scroll", loadWhenNearBottom);
  }, [activeDetailView, visibleActivities.length, visibleCount]);

  return (
    <aside className="details-panel pane-details" data-details-session={sessionId}>
      <div className="details-header">
        <div><span className="context-kicker">THREAD DETAIL</span><h2>{title}</h2></div>
      </div>
      <div className="details-tabs">
        <button className={activeDetailView === "activity" ? "active" : ""} onClick={() => onSelectView(sessionId, "activity")}>进度</button>
        {capabilities.plans === "supported" ? <button className={activeDetailView === "plan" ? "active" : ""} onClick={() => onSelectView(sessionId, "plan")}><ListChecks size={11} />计划</button> : null}
        {capabilities.subagents === "supported" ? <button className={activeDetailView === "agents" ? "active" : ""} onClick={() => onSelectView(sessionId, "agents")}><Bot size={11} />Agent</button> : null}
        {capabilities.goals === "supported" ? <button className={activeDetailView === "goal" ? "active" : ""} onClick={() => onSelectView(sessionId, "goal")}><Target size={11} />目标</button> : null}
      </div>
      <div className="details-scroll" ref={detailsScrollRef}>
        {activeDetailView === "goal" ? <GoalPanel goal={goal} working={working} readOnly={readOnly} onStart={(objective) => onStartGoal(sessionId, objective)} onStop={() => onStopGoal(sessionId)} />
          : activeDetailView === "plan" ? <PlanPanel plan={plan} />
          : activeDetailView === "agents" ? <SubagentPanel subagents={subagents} dismissedNoticeKeys={dismissedNoticeKeys} onDismissNotice={onDismissNotice} />
          : activeDetailView === "activity"
          ? <>
            <div className="details-view-hint">只看这里就够了：上方是 Codex 最新正在做的事。命令会显示具体命令和目录，文件会显示路径，输出可展开。</div>
            {visibleActivities.length
            ? <>
              {shownActivities.map((activity, index) => <div className={`activity-item ${activity.status}`} key={`${activity.id}:${index}`}>
                <div className="activity-icon"><ActivityIcon kind={activity.kind} status={activity.status} /></div>
                <div className="activity-body">
                  <div className="activity-title"><span>{activity.title}</span><span className="activity-meta">{formatEventTimestamp(activity.timestamp) ? <time dateTime={new Date(activity.timestamp!).toISOString()}>{formatEventTimestamp(activity.timestamp)}</time> : null}<span className="activity-status">{STATUS_LABEL[activity.status]}</span></span></div>
                  <p className="activity-detail">{activity.detail || "正在处理当前任务"}</p>
                  <ActivityOutput output={activity.output || ""} variant="detail" />
                </div>
                {isActivityNoticeDismissible(activity) ? <button type="button" className="bare-button activity-dismiss" onClick={() => onDismissNotice(activityNoticeKey(activity))} title="关闭活动提示" aria-label="关闭活动提示"><X size={13} /></button> : null}
              </div>)}
              {hiddenCount > 0 ? <button className="history-more" onClick={() => setVisibleCount((count) => Math.min(count + ACTIVITY_LOAD_COUNT, visibleActivities.length))}>继续下滑加载更早进度 · 剩余 {hiddenCount}</button> : null}
            </>
            : <div className="details-empty">{working ? "Codex 正在处理，进度即将显示" : "暂无进度"}</div>}
          </>
          : null}
      </div>
      <div className="details-footer"><span><CircleDot size={13} /> 最新进度在上方 · 压缩 {compactionCount} 轮</span></div>
    </aside>
  );
}

export default memo(DetailsPanelBase);
