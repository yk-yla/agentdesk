import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionSettingsCoordinator, type SessionSettings } from "./sessionSettingsCoordinator";

describe("SessionSettingsCoordinator", () => {
  it("sends the full latest target after an earlier request fails", async () => {
    const coordinator = new SessionSettingsCoordinator();
    coordinator.initialize("session", { model: "m0", effort: "e0", collaborationMode: "default" });
    const sent: SessionSettings[] = [];
    const first = coordinator.enqueue("session", { model: "m1", effort: "e1", collaborationMode: "default" }, async (settings) => {
      sent.push(settings);
      throw new Error("first failed");
    });
    const second = coordinator.enqueue("session", { model: "m1", effort: "e2", collaborationMode: "plan" }, async (settings) => {
      sent.push(settings);
    });
    await assert.rejects(first.promise);
    await second.promise;
    assert.deepEqual(sent, [
      { model: "m1", effort: "e1", collaborationMode: "default" },
      { model: "m1", effort: "e2", collaborationMode: "plan" },
    ]);
    assert.deepEqual(
      coordinator.confirmed("session", { model: "", effort: "", collaborationMode: "default" }),
      { model: "m1", effort: "e2", collaborationMode: "plan" },
    );
  });

  it("keeps the last confirmed settings when the latest request fails", async () => {
    const coordinator = new SessionSettingsCoordinator();
    coordinator.initialize("session", { model: "m0", effort: "e0", collaborationMode: "default" });
    const request = coordinator.enqueue("session", { model: "m1", effort: "e1", collaborationMode: "plan" }, async () => { throw new Error("failed"); });
    await assert.rejects(request.promise);
    assert.equal(request.isLatest(), true);
    assert.deepEqual(
      coordinator.confirmed("session", { model: "", effort: "", collaborationMode: "default" }),
      { model: "m0", effort: "e0", collaborationMode: "default" },
    );
  });
});
