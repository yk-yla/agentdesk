import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionLifecycleController } from "./sessionLifecycleController";

describe("SessionLifecycleController", () => {
  it("shares one resume and allows a later retry after it settles", async () => {
    const controller = new SessionLifecycleController();
    let calls = 0;
    let finish!: (value: string) => void;
    const first = controller.resume("session", () => {
      calls += 1;
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const second = controller.resume("session", async () => {
      calls += 1;
      return "unexpected";
    });
    assert.equal(first, second);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    finish("ready");
    assert.equal(await first, "ready");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(await controller.resume("session", async () => { calls += 1; return "again"; }), "again");
    assert.equal(calls, 2);
  });

  it("waits for an existing thread resume before declaring it ready", async () => {
    const controller = new SessionLifecycleController();
    const order: string[] = [];
    const threadId = await controller.ensureThread("session", {
      threadId: "native",
      resumed: false,
      claimExisting: () => order.push("claimed"),
      resume: async () => { order.push("resumed"); },
      start: async () => { throw new Error("must not start"); },
      adopt: () => "unused",
      isStartTimeout: () => false,
      onStartTimeout: () => undefined,
    });
    assert.equal(threadId, "native");
    assert.deepEqual(order, ["claimed", "resumed"]);
  });

  it("deduplicates close operations and permits a later close", async () => {
    const controller = new SessionLifecycleController();
    let calls = 0;
    let finish!: () => void;
    const first = controller.close("session", () => {
      calls += 1;
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    const second = controller.close("session", async () => { calls += 1; });
    assert.equal(first, second);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    finish();
    await first;
    await controller.close("session", async () => { calls += 1; });
    assert.equal(calls, 2);
  });

  it("adopts a late start response through the original single-flight", async () => {
    const controller = new SessionLifecycleController();
    const pending = controller.ensureThread("session", {
      threadId: null,
      resumed: false,
      start: () => Promise.reject(Object.assign(new Error("timeout"), { timeout: true })),
      adopt: (value) => String(value),
      isStartTimeout: (error) => Boolean((error as { timeout?: boolean }).timeout),
      onStartTimeout: () => undefined,
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(controller.resolveLateStart("session", "native", (value) => String(value)), true);
    assert.equal(await pending, "native");
  });
});
