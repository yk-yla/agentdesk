import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeSessionResources, reuseSessionClose } from "./sessionLifecycle";

describe("session lifecycle close", () => {
  it("always closes resources when interrupt fails", async () => {
    const calls: string[] = [];
    const result = await closeSessionResources({
      shouldInterrupt: true,
      interrupt: async () => { calls.push("interrupt"); throw new Error("interrupt failed"); },
      waitForIdle: async () => { calls.push("idle"); },
      close: async () => { calls.push("close"); },
    });
    assert.deepEqual(calls, ["interrupt", "close"]);
    assert.match(String(result.interruptError), /interrupt failed/);
    assert.equal(result.closeError, undefined);
  });

  it("always closes resources when waiting for idle times out", async () => {
    const calls: string[] = [];
    const result = await closeSessionResources({
      shouldInterrupt: true,
      interrupt: async () => { calls.push("interrupt"); },
      waitForIdle: async () => { calls.push("idle"); throw new Error("等待任务停止超时。"); },
      close: async () => { calls.push("close"); },
    });
    assert.deepEqual(calls, ["interrupt", "idle", "close"]);
    assert.match(String(result.interruptError), /超时/);
  });

  it("reports close failure separately and skips interrupt for an idle session", async () => {
    const calls: string[] = [];
    const result = await closeSessionResources({
      shouldInterrupt: false,
      interrupt: async () => { calls.push("interrupt"); },
      waitForIdle: async () => { calls.push("idle"); },
      close: async () => { calls.push("close"); throw new Error("close failed"); },
    });
    assert.deepEqual(calls, ["close"]);
    assert.equal(result.interruptError, undefined);
    assert.match(String(result.closeError), /close failed/);
  });

  it("supports batch partial success without masking a failed session", async () => {
    const closed: string[] = [];
    const results = await Promise.all(["ok", "bad", "ok-2"].map((id) => closeSessionResources({
      shouldInterrupt: true,
      interrupt: async () => undefined,
      waitForIdle: async () => undefined,
      close: async () => { if (id === "bad") throw new Error("close failed"); closed.push(id); },
    })));
    assert.deepEqual(closed.sort(), ["ok", "ok-2"]);
    assert.equal(results.filter((result) => result.closeError !== undefined).length, 1);
  });

  it("deduplicates repeated close requests for the same session", async () => {
    const active = new Map<string, Promise<void>>();
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const create = () => { calls += 1; return pending; };
    const first = reuseSessionClose(active, "session-1", create);
    const second = reuseSessionClose(active, "session-1", create);
    assert.equal(first, second);
    assert.equal(calls, 1);
    release();
    await first;
    assert.equal(active.has("session-1"), false);
  });
});
