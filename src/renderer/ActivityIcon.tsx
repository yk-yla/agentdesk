import { Bot, Check, CircleX, FileCode2, LoaderCircle, Terminal, XCircle } from "lucide-react";
import { memo } from "react";
import type { Activity } from "./domain";
import { activityIconName } from "./activityIconPresentation";

/** 活动图标在主对话流和详情面板都会用，抽出来避免两处重复。 */
function ActivityIconBase({ kind, status }: { kind: Activity["kind"]; status: Activity["status"] }) {
  const icon = activityIconName(kind, status);
  if (icon === "terminal") return <Terminal size={14} />;
  if (icon === "file") return <FileCode2 size={14} />;
  if (icon === "bot") return <Bot size={14} />;
  if (icon === "loading") return <LoaderCircle size={14} className="spin" />;
  if (icon === "interrupted") return <CircleX size={14} />;
  if (icon === "failed") return <XCircle size={14} />;
  return <Check size={14} />;
}

export default memo(ActivityIconBase);
