import type { Activity } from "./domain";

const SIMPLE_ACTIVITY_STATUSES = new Set<Activity["status"]>(["failed", "declined", "interrupted"]);

export function activitiesForMainConversation(activities: Activity[]) {
  return activities.filter((activity) => activity.visibleInMain && SIMPLE_ACTIVITY_STATUSES.has(activity.status));
}
