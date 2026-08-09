import { Check, Circle, LoaderCircle, ListChecks } from "lucide-react";
import { memo } from "react";
import type { SessionPlan } from "./domain";

interface Props {
  plan: SessionPlan | null;
}

function PlanPanel({ plan }: Props) {
  if (!plan) {
    return <div className="details-empty"><span>当前回合还没有计划</span></div>;
  }
  return (
    <div className="plan-panel">
      <div className="plan-panel-heading"><ListChecks size={16} /><strong>执行计划</strong></div>
      {plan.explanation ? <pre className="plan-explanation">{plan.explanation}</pre> : null}
      <ol className="plan-steps">
        {plan.steps.map((step, index) => (
          <li className={`plan-step ${step.status}`} key={`${index}-${step.step}`}>
            <span className="plan-step-icon">{step.status === "completed" ? <Check size={13} /> : step.status === "inProgress" ? <LoaderCircle size={13} className="spin" /> : <Circle size={11} />}</span>
            <span>{step.step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default memo(PlanPanel);
