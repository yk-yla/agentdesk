import type { Activity } from "./domain";

export type ActivityIconName = "bot" | "check" | "failed" | "file" | "interrupted" | "loading" | "terminal";

export function activityIconName(kind: Activity["kind"], status: Activity["status"]): ActivityIconName {
  if (status === "failed" || status === "declined") return "failed";
  if (status === "interrupted") return "interrupted";
  if (kind === "commandExecution") return "terminal";
  if (kind === "fileChange") return "file";
  if (kind === "subAgent") return "bot";
  if (status === "inProgress") return "loading";
  return "check";
}
