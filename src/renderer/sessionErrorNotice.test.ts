import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptySession } from "./domain";
import { currentSessionErrorNotice, normalizeSessionErrorNotice, sessionErrorAutoDismissMs, sessionErrorNoticeIdentity, sessionErrorNoticePatch } from "./sessionErrorNotice";

describe("session error notice lifecycle", () => {
  it("defaults unclassified errors to manual dismissal", () => {
    const current = emptySession("session-1", "C:\\workspace");
    const next = normalizeSessionErrorNotice(current, { ...current, errorText: "恢复失败" }, 10);
    assert.deepEqual(currentSessionErrorNotice(next), { message: "恢复失败", lifetime: "manual", createdAt: 10 });
    assert.equal(sessionErrorAutoDismissMs(next), null);
  });

  it("marks explicit transient notices and clears stale metadata", () => {
    const current = { ...emptySession("session-1", "C:\\workspace"), ...sessionErrorNoticePatch("格式不支持", { lifetime: "transient", durationMs: 6_000, now: 10 }) };
    assert.equal(sessionErrorAutoDismissMs(current), 6_000);
    const replaced = normalizeSessionErrorNotice(current, { ...current, errorText: "Provider 已退出" }, 20);
    assert.equal(replaced.errorNotice?.lifetime, "manual");
    assert.equal(replaced.errorNotice?.message, "Provider 已退出");
    const cleared = normalizeSessionErrorNotice(replaced, { ...replaced, errorText: "" }, 30);
    assert.equal(cleared.errorNotice, undefined);
  });

  it("gives each current notice a guard identity", () => {
    const first = { ...emptySession("session-1", "C:\\workspace"), ...sessionErrorNoticePatch("相同提示", { lifetime: "transient", now: 10 }) };
    const second = { ...first, ...sessionErrorNoticePatch("相同提示", { lifetime: "transient", now: 20 }) };
    assert.notEqual(sessionErrorNoticeIdentity(first), sessionErrorNoticeIdentity(second));
  });
});
