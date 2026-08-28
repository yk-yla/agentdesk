import type { DesktopPreferences } from "../shared/protocol";
import type { Activity, SessionGoal, SubagentState } from "./domain";

const MAX_SESSION_NOTICE_SESSIONS = 512;
const MAX_SESSION_NOTICE_KEYS = 128;

function noticeFingerprint(kind: string, parts: readonly unknown[]) {
  const value = JSON.stringify(parts.map((part) => part ?? null));
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    second ^= second >>> 13;
  }
  const digest = `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
  return `${kind}:${digest}:${value.length}`;
}

export function activityNoticeKey(activity: Pick<Activity, "id">) {
  // Provider activity status and detail can change during one lifecycle. The
  // provider-owned activity ID is the only stable identity we persist.
  return noticeFingerprint("activity", [activity.id]);
}

export function legacyActivityNoticeKey(activity: Pick<Activity, "id" | "kind" | "status" | "title" | "detail">) {
  return noticeFingerprint("activity", [activity.id, activity.kind, activity.status, activity.title, activity.detail]);
}

export function isActivityNoticeDismissed(
  activity: Pick<Activity, "id" | "kind" | "status" | "title" | "detail">,
  dismissedNoticeKeys: ReadonlySet<string>,
) {
  return dismissedNoticeKeys.has(activityNoticeKey(activity)) || dismissedNoticeKeys.has(legacyActivityNoticeKey(activity));
}

export function errorNoticeKey(errorText: string) {
  return noticeFingerprint("error", [errorText]);
}

export function completedGoalNoticeKey(goal: Pick<SessionGoal, "threadId" | "updatedAt" | "objective" | "status">) {
  return noticeFingerprint("goal", [goal.threadId, goal.updatedAt, goal.objective, goal.status]);
}

export function subagentNoticeKey(agent: Pick<SubagentState, "threadId" | "status" | "message">) {
  return noticeFingerprint("subagent", [agent.threadId, agent.status, agent.message || ""]);
}

export function addDismissedSessionNotice(
  current: NonNullable<DesktopPreferences["dismissedSessionNotices"]>,
  sessionKey: string,
  noticeKey: string,
  updatedAt = Date.now(),
): NonNullable<DesktopPreferences["dismissedSessionNotices"]> {
  return addDismissedSessionNotices(current, sessionKey, [noticeKey], updatedAt);
}

export function addDismissedSessionNotices(
  current: NonNullable<DesktopPreferences["dismissedSessionNotices"]>,
  sessionKey: string,
  noticeKeys: readonly string[],
  updatedAt = Date.now(),
): NonNullable<DesktopPreferences["dismissedSessionNotices"]> {
  const existing = current[sessionKey]?.keys || [];
  const appended = [...new Set(noticeKeys.filter((key) => key.length > 0))];
  if (!appended.length) return current;
  const appendedSet = new Set(appended);
  const keys = [...existing.filter((key) => !appendedSet.has(key)), ...appended].slice(-MAX_SESSION_NOTICE_KEYS);
  return Object.fromEntries(Object.entries({ ...current, [sessionKey]: { keys, updatedAt } })
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, MAX_SESSION_NOTICE_SESSIONS));
}
