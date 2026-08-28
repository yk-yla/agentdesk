import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DesktopPreferences } from "../shared/protocol";
import { activityNoticeKey, addDismissedSessionNotice, addDismissedSessionNotices, errorNoticeKey, isActivityNoticeDismissed, legacyActivityNoticeKey } from "./sessionNoticeDismissal";

describe("session notice dismissal", () => {
  it("creates stable keys without retaining full notice text", () => {
    const activity = { id: "tool-1", kind: "mcpToolCall" as const, status: "failed" as const, title: "调用工具", detail: "openaiDeveloperDocs / search_openai_docs" };
    const updatedActivity = { ...activity, status: "interrupted" as const, detail: "新的错误详情" };
    assert.equal(activityNoticeKey(activity), activityNoticeKey({ ...activity }));
    assert.equal(activityNoticeKey(activity), activityNoticeKey(updatedActivity));
    assert.equal(isActivityNoticeDismissed(activity, new Set([legacyActivityNoticeKey(activity)])), true);
    assert.equal(isActivityNoticeDismissed(updatedActivity, new Set([legacyActivityNoticeKey(activity)])), false);
    assert.equal(errorNoticeKey("请求失败"), errorNoticeKey("请求失败"));
    assert.equal(errorNoticeKey("请求失败").includes("请求失败"), false);
  });

  it("deduplicates keys and bounds sessions and notices", () => {
    let records: NonNullable<DesktopPreferences["dismissedSessionNotices"]> = {};
    for (let sessionIndex = 0; sessionIndex < 520; sessionIndex += 1) {
      records = addDismissedSessionNotice(records, `codex:session-${sessionIndex}`, "activity:0", sessionIndex + 1);
    }
    for (let noticeIndex = 1; noticeIndex < 130; noticeIndex += 1) {
      records = addDismissedSessionNotice(records, "codex:session-519", `activity:${noticeIndex}`, 520 + noticeIndex);
    }
    assert.equal(Object.keys(records).length, 512);
    assert.equal(records["codex:session-519"].keys.length, 128);
    assert.equal(records["codex:session-519"].keys[0], "activity:2");
    assert.equal(records["codex:session-0"], undefined);

    const duplicate = addDismissedSessionNotice(records, "codex:session-519", "activity:129", 999);
    assert.equal(duplicate["codex:session-519"].keys.filter((key) => key === "activity:129").length, 1);
  });

  it("adds a batch of dismissed notices in one record update", () => {
    const result = addDismissedSessionNotices({}, "codex:thread-1", ["activity:one", "activity:two", "activity:one"], 10);
    assert.deepEqual(result["codex:thread-1"], { keys: ["activity:one", "activity:two"], updatedAt: 10 });
    assert.equal(addDismissedSessionNotices(result, "codex:thread-1", [], 11), result);
  });
});
