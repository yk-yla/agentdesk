import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CODEX_CAPABILITIES, emptySession } from "./domain";
import { SessionTitleController } from "./sessionTitleController";

function createHarness() {
  const session = Object.assign(emptySession("session", "D:\\work"), {
    threadId: "thread",
    title: "首条消息标题",
    titleOrigin: "fallback" as const,
    capabilities: { ...CODEX_CAPABILITIES },
    messages: [
      { id: "user", role: "user" as const, text: "实现会话标题自动生成", images: [] },
      { id: "assistant", role: "assistant" as const, text: "我会先检查 Provider 标题能力。", images: [] },
    ],
  });
  let requestCount = 0;
  let applied: { title: string; source: string } | null = null;
  const controller = new SessionTitleController({ getSession: () => session }, {
    request: async (_sessionId, operation, params) => {
      requestCount += 1;
      assert.equal(operation, "generateSessionTitle");
      assert.equal(params.threadId, "thread");
      assert.match(String(params.conversation), /会话标题自动生成/);
      return { title: "Provider 标题", source: "generated" };
    },
    applyTitle: (_sessionId, title, source) => { applied = { title, source }; },
  });
  return { controller, session, get requestCount() { return requestCount; }, get applied() { return applied; } };
}

describe("SessionTitleController", () => {
  it("requests a title once for a fallback title and applies the result", async () => {
    const harness = createHarness();
    harness.controller.refreshAfterTurn("session", "completed");
    harness.controller.refreshAfterTurn("session", "completed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.requestCount, 1);
    assert.deepEqual(harness.applied, { title: "Provider 标题", source: "generated" });
  });

  it("does not apply a stale result after manual invalidation", async () => {
    const harness = createHarness();
    let resolveRequest!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { resolveRequest = resolve; });
    const staleHarness = new SessionTitleController({ getSession: () => harness.session }, {
      request: async () => pending,
      applyTitle: (_sessionId, title, source) => { harness.session.title = `${source}:${title}`; },
    });
    staleHarness.refreshAfterTurn("session", "completed");
    staleHarness.invalidate("session");
    resolveRequest({ title: "过期标题", source: "generated" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.session.title, "首条消息标题");
  });

  it("ignores interrupted and failed turns", () => {
    const harness = createHarness();
    harness.controller.refreshAfterTurn("session", "interrupted");
    harness.controller.refreshAfterTurn("session", "failed");
    assert.equal(harness.requestCount, 0);
  });
});
