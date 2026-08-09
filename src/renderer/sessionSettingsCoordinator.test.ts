import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionSettingsCoordinator, type SessionSettings } from "./sessionSettingsCoordinator";

describe("SessionSettingsCoordinator", () => {
  it("sends the full latest target after an earlier request fails", async () => {
    const coordinator = new SessionSettingsCoordinator();
    coordinator.initialize("session", { model: "m0", effort: "e0" });
    const sent: SessionSettings[] = [];
    const first = coordinator.enqueue("session", { model: "m1", effort: "e1" }, async (settings) => {
      sent.push(settings);
      throw new Error("first failed");
    });
    const second = coordinator.enqueue("session", { model: "m1", effort: "e2" }, async (settings) => {
      sent.push(settings);
    });
    await assert.rejects(first.promise);
    await second.promise;
    assert.deepEqual(sent, [{ model: "m1", effort: "e1" }, { model: "m1", effort: "e2" }]);
    assert.deepEqual(coordinator.confirmed("session", { model: "", effort: "" }), { model: "m1", effort: "e2" });
  });

  it("keeps the last confirmed settings when the latest request fails", async () => {
    const coordinator = new SessionSettingsCoordinator();
    coordinator.initialize("session", { model: "m0", effort: "e0" });
    const request = coordinator.enqueue("session", { model: "m1", effort: "e1" }, async () => { throw new Error("failed"); });
    await assert.rejects(request.promise);
    assert.equal(request.isLatest(), true);
    assert.deepEqual(coordinator.confirmed("session", { model: "", effort: "" }), { model: "m0", effort: "e0" });
  });
});
