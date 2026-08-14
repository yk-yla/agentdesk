import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkspaceSnapshotCoordinator } from "./workspaceSnapshotCoordinator";

describe("WorkspaceSnapshotCoordinator", () => {
  it("waits until the requested snapshot is persisted", async () => {
    let requestedId = "";
    let saved: unknown;
    const coordinator = new WorkspaceSnapshotCoordinator({
      createRequestId: () => "snapshot-1",
      requestFromRenderer: (requestId) => { requestedId = requestId; return true; },
      save: async (workspaceState) => { saved = workspaceState; },
    });

    const request = coordinator.request(1_000);
    assert.equal(requestedId, "snapshot-1");
    await coordinator.complete(requestedId, { layout: "two-panes" });
    assert.equal(await request, "saved");
    assert.deepEqual(saved, { layout: "two-panes" });
  });

  it("uses the last automatic snapshot when the renderer is unavailable or late", async () => {
    const unavailable = new WorkspaceSnapshotCoordinator({
      createRequestId: () => "snapshot-unavailable",
      requestFromRenderer: () => false,
      save: async () => undefined,
    });
    assert.equal(await unavailable.request(1_000), "renderer-unavailable");

    const late = new WorkspaceSnapshotCoordinator({
      createRequestId: () => "snapshot-late",
      requestFromRenderer: () => true,
      save: async () => undefined,
    });
    assert.equal(await late.request(5), "timeout");
    await assert.rejects(() => late.complete("snapshot-late", {}), /已过期/);
  });

  it("does not report success when persistence fails", async () => {
    const coordinator = new WorkspaceSnapshotCoordinator({
      createRequestId: () => "snapshot-failed",
      requestFromRenderer: () => true,
      save: async () => { throw new Error("disk full"); },
    });
    const request = coordinator.request(1_000);
    await assert.rejects(() => coordinator.complete("snapshot-failed", {}), /disk full/);
    await assert.rejects(request, /disk full/);
  });
});
