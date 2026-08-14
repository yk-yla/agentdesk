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
  logger: unknown = {};
  feedToken = "";
  installs = 0;

  setFeedURL(options: { token: string }) { this.feedToken = options.token; }
  async checkForUpdates() { this.emit("update-available", { version: "2.0.0" }); }
  async downloadUpdate() { this.emit("update-downloaded", { version: "2.0.0" }); }
  quitAndInstall() { this.installs += 1; }
}

function withManager(run: (manager: DesktopUpdateManager, updater: FakeUpdater, statuses: DesktopUpdateStatus[]) => Promise<void> | void) {
  const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-desktop-update-"));
  const updater = new FakeUpdater();
  const statuses: DesktopUpdateStatus[] = [];
  const dependencies: DesktopUpdateManagerDependencies = {
    updater,
    storage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, "utf8"),
      decryptString: (value) => value.toString("utf8"),
    },
    currentVersion: () => "1.0.0",
    isPackaged: () => true,
    userDataPath: () => directory,
    emitStatus: (status) => statuses.push(status),
    prepareInstall: async () => undefined,
    scheduleInstall: (install) => install(),
    environment: {},
  };
  return Promise.resolve(run(new DesktopUpdateManager(dependencies), updater, statuses))
    .finally(() => rmSync(directory, { recursive: true, force: true }));
}

describe("DesktopUpdateManager", () => {
  it("classifies authorization, network and release errors", () => {
    assert.match(desktopUpdateErrorMessage(new Error("HTTP 403")), /授权失败/);
    assert.match(desktopUpdateErrorMessage(new Error("network timeout")), /无法连接/);
    assert.match(desktopUpdateErrorMessage(new Error("404 not found")), /没有可用/);
  });

  it("keeps check, download and install as separate user actions", async () => withManager(async (manager, updater) => {
    await manager.saveToken("github-token-with-enough-length");
    assert.equal((await manager.check()).phase, "available");
    assert.equal(updater.autoDownload, false);
    assert.equal((await manager.download()).phase, "downloaded");
    assert.equal(updater.installs, 0);
    await manager.install();
    assert.equal(updater.installs, 1);
  }));

  it("does not contact the updater without a token", async () => withManager(async (manager) => {
    assert.equal((await manager.check()).phase, "authorizationRequired");
  }));
});
