import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeBackend, paginateClaudeHistoryMessages } from "./ClaudeBackend";

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
