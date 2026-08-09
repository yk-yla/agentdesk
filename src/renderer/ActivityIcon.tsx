import { Bot, Check, CircleX, FileCode2, LoaderCircle, Terminal } from "lucide-react";
import { memo } from "react";
import type { Activity } from "./domain";

/** 活动图标在主对话流和详情面板都会用，抽出来避免两处重复。 */
function ActivityIconBase({ kind, status }: { kind: Activity["kind"]; status: Activity["status"] }) {
  if (kind === "commandExecution") return <Terminal size={14} />;
  if (kind === "fileChange") return <FileCode2 size={14} />;
  if (kind === "subAgent") return <Bot size={14} />;
  if (status === "inProgress") return <LoaderCircle size={14} className="spin" />;
  if (status === "interrupted") return <CircleX size={14} />;
  return <Check size={14} />;
}

export default memo(ActivityIconBase);
