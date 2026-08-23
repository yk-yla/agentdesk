import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { DesktopUpdateStatus } from "../shared/protocol";
import { DesktopUpdateManager, desktopUpdateErrorMessage, type DesktopUpdateManagerDependencies } from "./desktopUpdateManager";

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  fullChangelog = false;
  logger: unknown = {};
  feedToken = "";
  installs = 0;

  setFeedURL(options: { owner: string; repo: string }) { this.feedToken = `${options.owner}/${options.repo}`; }
  async checkForUpdates() {
    this.emit("update-available", {
      version: "2.0.0",
      releaseNotes: [
        { version: "2.0.0", note: "<p>修复首个问题。</p><ul><li>更新说明显示更清楚</li></ul>" },
        { version: "1.5.0", note: "<p>增加稳定性。</p>" },
      ],
    });
  }
  async downloadUpdate() { this.emit("update-downloaded", { version: "2.0.0" }); }
  quitAndInstall() { this.installs += 1; }
}

function withManager(run: (manager: DesktopUpdateManager, updater: FakeUpdater, statuses: DesktopUpdateStatus[]) => Promise<void> | void) {
  const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-desktop-update-"));
  const updater = new FakeUpdater();
  const statuses: DesktopUpdateStatus[] = [];
  const dependencies: DesktopUpdateManagerDependencies = {
    updater,
    currentVersion: () => "1.0.0",
    isPackaged: () => true,
    emitStatus: (status) => statuses.push(status),
    prepareInstall: async () => undefined,
    scheduleInstall: (install) => install(),
  };
  return Promise.resolve(run(new DesktopUpdateManager(dependencies), updater, statuses))
    .finally(() => rmSync(directory, { recursive: true, force: true }));
}

describe("DesktopUpdateManager", () => {
  it("classifies server, network and release errors", () => {
    assert.match(desktopUpdateErrorMessage(new Error("HTTP 403")), /暂时拒绝/);
    assert.match(desktopUpdateErrorMessage(new Error("network timeout")), /无法连接/);
    assert.match(desktopUpdateErrorMessage(new Error("404 not found")), /没有可用/);
  });

  it("keeps check, download and install as separate user actions", async () => withManager(async (manager, updater) => {
    const checked = await manager.check();
    assert.equal(checked.phase, "available");
    assert.equal(checked.releaseNotes?.length, 2);
    assert.match(checked.releaseNotes?.[0]?.note || "", /更新说明显示更清楚/);
    assert.equal(updater.fullChangelog, true);
    assert.equal(updater.autoDownload, false);
    assert.equal((await manager.download()).phase, "downloaded");
    assert.equal(updater.installs, 0);
    await manager.install();
    assert.equal(updater.installs, 1);
  }));

  it("checks a public repository without an authorization code", async () => withManager(async (manager, updater) => {
    assert.equal((await manager.check()).phase, "available");
    assert.equal(updater.feedToken, "yk-yla/agentdesk");
  }));

  it("does not contact the update source during initialization", async () => withManager(async (manager, updater) => {
    manager.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(updater.feedToken, "");
  }));
});
