import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeBackend, ClaudeHistoryMessageCache, paginateClaudeHistoryMessages } from "./ClaudeBackend";

describe("ClaudeBackend (external-terminal)", () => {
  it("pages the full history from the newest page back to the first", () => {
    const messages = Array.from({ length: 431 }, (_, index) => ({ index }));
    const latest = paginateClaudeHistoryMessages(messages, undefined, 200);
    assert.deepEqual(latest.messages.map((entry) => entry.index), Array.from({ length: 200 }, (_, index) => index + 231));
    assert.deepEqual(latest, { messages: latest.messages, offset: 231, total: 431, hasMoreBefore: true, hasMoreAfter: false });
    const middle = paginateClaudeHistoryMessages(messages, 31, 200);
    assert.equal(middle.offset, 31);
    assert.equal(middle.messages.length, 200);
    assert.equal(middle.hasMoreBefore, true);
    assert.equal(middle.hasMoreAfter, true);
    const first = paginateClaudeHistoryMessages(messages, 0, 200);
    assert.equal(first.messages.length, 200);
    assert.equal(first.hasMoreBefore, false);
    assert.equal(first.hasMoreAfter, true);
  });

  it("deduplicates and bounds cached transcript loads", async () => {
    let now = 1_000;
    let loads = 0;
    const cache = new ClaudeHistoryMessageCache(1, 2, 100, () => now);
    const loader = async () => { loads += 1; return [{ id: "one" }]; };
    const first = cache.get("session", loader);
    const second = cache.get("session", loader);
    assert.strictEqual(await first, await second);
    assert.equal(loads, 1);
    now += 101;
    await cache.get("session", loader);
    assert.equal(loads, 2);
    await cache.get("other", async () => [{ id: "1" }]);
    await cache.get("session", loader);
    assert.equal(loads, 3);
  });

  it("keeps paginated cache entries separate and invalidates the session prefix", async () => {
    let loads = 0;
    const cache = new ClaudeHistoryMessageCache(8, 2, 60_000, () => 1_000);
    const page = (offset: number) => cache.get(`cwd\u0000session\u0000${offset}\u0000200`, async () => {
      loads += 1;
      return [{ offset }];
    });

    assert.equal(((await page(0))[0] as { offset: number }).offset, 0);
    assert.equal(((await page(200))[0] as { offset: number }).offset, 200);
    assert.equal(loads, 2);
    cache.invalidatePrefix("cwd\u0000session");
    assert.equal(((await page(0))[0] as { offset: number }).offset, 0);
    assert.equal(loads, 3);
  });

  it("returns simplified capabilities without query support", async () => {
    const backend = new ClaudeBackend();
    const capabilities = await backend.getCapabilities();
    assert.equal(capabilities.history, "supported");
    assert.equal(capabilities.historySearch, "supported");
    assert.equal(capabilities.rename, "supported");
    assert.equal(capabilities.fork, "supported");
    assert.equal(capabilities.delete, "supported");
    assert.equal(capabilities.models, "unsupported");
    assert.equal(capabilities.effort, "unsupported");
    assert.equal(capabilities.interrupt, "unsupported");
    assert.equal(capabilities.compact, "unsupported");
    assert.equal(capabilities.images, "unsupported");
    await backend.close();
  });

  it("registers and releases a session via startSession and closeSession", async () => {
    const backend = new ClaudeBackend();
    const sessionId = "test-session-1";
    const cwd = process.cwd();
    const result = await backend.request("startSession", { cwd }, { sessionId, canonicalCwd: cwd }) as { thread: { id: string } };
    assert.ok(result.thread.id);
    await backend.request("closeSession", {}, { sessionId, canonicalCwd: cwd });
    await backend.close();
  });

  it("rejects duplicate startSession for the same clientSessionId", async () => {
    const backend = new ClaudeBackend();
    const sessionId = "dup-session";
    const cwd = process.cwd();
    await backend.request("startSession", { cwd }, { sessionId, canonicalCwd: cwd });
    await assert.rejects(() => backend.request("startSession", { cwd }, { sessionId, canonicalCwd: cwd }), /已存在/);
    await backend.close();
  });

  it("rejects unsupported operations like startTurn", async () => {
    const backend = new ClaudeBackend();
    const sessionId = "unsupported-op";
    const cwd = process.cwd();
    await backend.request("startSession", { cwd }, { sessionId, canonicalCwd: cwd });
    await assert.rejects(() => backend.request("startTurn", { input: [{ type: "text", text: "hello" }] }, { sessionId, canonicalCwd: cwd }), /暂不支持/);
    await backend.close();
  });

  it("shutdown clears all sessions", async () => {
    const backend = new ClaudeBackend();
    const cwd = process.cwd();
    await backend.request("startSession", { cwd }, { sessionId: "s1", canonicalCwd: cwd });
    await backend.request("startSession", { cwd }, { sessionId: "s2", canonicalCwd: cwd });
    await backend.shutdown();
    // After shutdown, sessions are cleared - closeSession should not throw
    await backend.request("closeSession", {}, { sessionId: "s1", canonicalCwd: cwd });
    await backend.close();
  });
});
