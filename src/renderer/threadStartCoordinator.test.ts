import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ThreadStartCoordinator } from "./threadStartCoordinator";

describe("ThreadStartCoordinator", () => {
  it("shares one request for concurrent starts", async () => {
    const coordinator = new ThreadStartCoordinator();
    let requestCount = 0;
    const request = async () => { requestCount += 1; return { threadId: "thread-1" }; };
    const adopt = (value: unknown) => (value as { threadId: string }).threadId;

    const first = coordinator.start("session-1", request, adopt, () => false, () => undefined);
    const second = coordinator.start("session-1", request, adopt, () => false, () => undefined);

    assert.equal(first, second);
    assert.equal(await first, "thread-1");
    assert.equal(requestCount, 1);
  });

  it("waits for a late response after timeout instead of starting again", async () => {
    const coordinator = new ThreadStartCoordinator();
    const timeout = new Error("timeout");
    let requestCount = 0;
    let timeoutCount = 0;
    const request = async () => { requestCount += 1; throw timeout; };
    const onTimeout = () => { timeoutCount += 1; };
    const adopt = (value: unknown) => (value as { threadId: string }).threadId;
    const pending = coordinator.start("session-1", request, adopt, (error) => error === timeout, onTimeout);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(timeoutCount, 1);

    const duplicate = coordinator.start("session-1", request, adopt, () => false, () => undefined);
    assert.equal(duplicate, pending);
    assert.equal(requestCount, 1);
    assert.equal(coordinator.resolveLate("session-1", { threadId: "thread-late" }, adopt), true);
    assert.equal(await pending, "thread-late");
  });

  it("rejects pending starts when the app-server exits", async () => {
    const coordinator = new ThreadStartCoordinator();
    const pending = coordinator.start("session-1", () => new Promise(() => undefined), () => "", () => false, () => undefined);
    coordinator.rejectAll(new Error("server exited"));
    await assert.rejects(pending, /server exited/);
  });

  it("rejects a timed-out start when no late response arrives", async () => {
    const coordinator = new ThreadStartCoordinator(10);
    const timeout = new Error("timeout");
    let cleanupCount = 0;
    const pending = coordinator.start("session-1", async () => { throw timeout; }, () => "", (error) => error === timeout, () => undefined, async () => { cleanupCount += 1; });
    await assert.rejects(pending, /后台确认超时/);
    assert.equal(cleanupCount, 1);
  });
});
