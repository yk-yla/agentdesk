import { Bot, Check, CircleDot, LoaderCircle, X } from "lucide-react";
import { memo } from "react";
import type { SubagentState } from "./domain";

interface Props {
  subagents: SubagentState[];
}

const STATUS: Record<SubagentState["status"], string> = {
  pendingInit: "准备中", running: "运行中", interrupted: "已中断", completed: "已完成", errored: "失败", shutdown: "已关闭", notFound: "未找到",
};

function SubagentPanel({ subagents }: Props) {
  if (!subagents.length) return <div className="details-empty"><span>当前会话还没有子 Agent</span></div>;
  return (
    <div className="subagent-panel">
      {subagents.map((agent) => (
        <article className={`subagent-card ${agent.status}`} key={agent.threadId}>
          <div className="subagent-card-heading"><span className="subagent-icon"><Bot size={14} /></span><strong>{agent.nickname || "子 Agent"}</strong><span className="subagent-status">{agent.status === "running" ? <LoaderCircle size={11} className="spin" /> : agent.status === "completed" ? <Check size={11} /> : agent.status === "errored" || agent.status === "interrupted" ? <X size={11} /> : <CircleDot size={11} />}{STATUS[agent.status]}</span></div>
          {agent.role ? <div className="subagent-meta">{agent.role}</div> : null}
          {agent.prompt ? <div className="subagent-prompt">{agent.prompt}</div> : null}
          {agent.message ? <pre className="subagent-message">{agent.message}</pre> : null}
          <div className="subagent-meta">{agent.model || "默认模型"}{agent.effort ? ` · ${agent.effort}` : ""}</div>
        </article>
      ))}
    </div>
  );
}

export default memo(SubagentPanel);
