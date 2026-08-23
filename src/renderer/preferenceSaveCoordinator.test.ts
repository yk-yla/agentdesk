import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PreferenceSaveCoordinator } from "./preferenceSaveCoordinator";

const snapshot = (extra: Partial<import("../shared/protocol").DesktopPreferences> = {}) => ({
  lastWorkspace: "",
  favoriteWorkspaces: [],
  theme: "github-light" as const,
  ...extra,
});

describe("PreferenceSaveCoordinator", () => {
  it("accepts only fields included in the write", () => {
    const coordinator = new PreferenceSaveCoordinator();
    const ticket = coordinator.begin({ sidebarWidth: 320 });
    const accepted = coordinator.accept(ticket, snapshot({ sidebarWidth: 320, recentCommandUsage: { old: 1 } }));
    assert.deepEqual(accepted, { sidebarWidth: 320 });
  });

  it("ignores an older response for a field written again later", () => {
    const coordinator = new PreferenceSaveCoordinator();
    const first = coordinator.begin({ recentCommandUsage: { first: 1 } });
    const second = coordinator.begin({ recentCommandUsage: { second: 2 } });
    assert.deepEqual(coordinator.accept(first, snapshot({ recentCommandUsage: { first: 1 } })), {});
    assert.deepEqual(coordinator.accept(second, snapshot({ recentCommandUsage: { second: 2 } })), { recentCommandUsage: { second: 2 } });
  });
});
