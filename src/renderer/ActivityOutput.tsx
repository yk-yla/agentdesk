import { ChevronDown, ChevronRight } from "lucide-react";
import { memo, useState } from "react";

interface Props {
  output: string;
  variant: "main" | "detail";
}

function ActivityOutputBase({ output, variant }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (!output) return null;

  return (
    <div className={`activity-output ${variant}`}>
      <button
        type="button"
        className="activity-output-toggle"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{expanded ? "收起输出" : "查看输出"}</span>
      </button>
      {expanded ? <pre className="activity-output-content">{output}</pre> : null}
    </div>
  );
}

export default memo(ActivityOutputBase);
