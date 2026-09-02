import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { CodexCliUpdateStatus } from "../shared/protocol";
import { CodexCliUpdateManager, compareVersions } from "./codexCliUpdateManager";
import { ProcessSupervisor } from "./processSupervisor";

describe("CodexCliUpdateManager", () => {
  it("compares releases", () => {
    assert.equal(compareVersions("1.2.4", "1.2.3") > 0, true);
    assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  });

  it("explains GitHub rate limiting when the release query returns 403", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-codex-rate-limit-"));
    try {
      const manager = new CodexCliUpdateManager({
        processSupervisor: new ProcessSupervisor(async () => undefined),
        appServer: { isRunning: false, close: async () => undefined, ensureStarted: async () => undefined },
        userDataPath: () => directory,
        isQuitting: () => false,
        emitStatus: () => undefined,
        notify: () => undefined,
        environment: {},
        runtimeSnapshot: () => ({ provider: "codex", source: "native", executablePath: "C:\\codex.exe", currentVersion: "1.0.0", detectedAt: 1, updateStrategy: "self" }),
        fetch: async () => new Response(null, { status: 403 }),
      });

      await manager.initialize();
      const status = await manager.check(true);
      assert.equal(status.phase, "error");
      assert.match(status.message, /HTTP 403/);
      assert.match(status.message, /匿名访问限流/);
      manager.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serializes check and update while restoring the local app-server", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-codex-update-"));
    const statuses: CodexCliUpdateStatus[] = [];
    const notifications: string[] = [];
    let installed = "1.0.0";
    let restarts = 0;
    try {
      const manager = new CodexCliUpdateManager({
        processSupervisor: new ProcessSupervisor(async () => undefined),
        appServer: {
          isRunning: true,
          close: async () => undefined,
          ensureStarted: async () => { restarts += 1; },
        },
        userDataPath: () => directory,
        isQuitting: () => false,
        emitStatus: (status) => statuses.push(status),
        notify: (title) => notifications.push(title),
        isCliInUse: async () => false,
        environment: {},
        operations: {
          readInstalledVersion: async () => installed,
          readLatestVersion: async () => "1.1.0",
          installVersion: async (version) => { installed = version; },
        },
      });

      assert.equal((await manager.check(true)).phase, "available");
      assert.equal((await manager.update()).phase, "upToDate");
      assert.equal(restarts, 1);
      assert.deepEqual(notifications, ["Codex CLI 已更新"]);
      assert.equal(manager.active, false);
      manager.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks updating without terminating an external Codex process", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-codex-external-"));
    let closeCount = 0;
    let installCount = 0;
    const terminated: number[] = [];
    let installed = "1.0.0";
    try {
      const manager = new CodexCliUpdateManager({
        processSupervisor: new ProcessSupervisor(async () => undefined),
        appServer: {
          isRunning: true,
          close: async () => { closeCount += 1; },
          ensureStarted: async () => undefined,
        },
        userDataPath: () => directory,
        isQuitting: () => false,
        emitStatus: () => undefined,
        notify: () => undefined,
        isCliInUse: async () => true,
        environment: {},
        operations: {
          readInstalledVersion: async () => installed,
          readLatestVersion: async () => "1.1.0",
          installVersion: async (version) => { installCount += 1; installed = version; },
        },
      });

      await manager.check(true);
      const status = await manager.update();

      assert.equal(status.phase, "error");
      assert.match(status.message, /正在被会话使用/);
      assert.equal(closeCount, 0);
      assert.equal(installCount, 0);
      assert.deepEqual(terminated, []);
      manager.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("closes every AgentDesk-owned app-server before updating", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-codex-owned-servers-"));
    let primaryCloses = 0;
    let historyCloses = 0;
    let installed = "1.0.0";
    try {
      const manager = new CodexCliUpdateManager({
        processSupervisor: new ProcessSupervisor(async () => undefined),
        appServer: {
          isRunning: true,
          close: async () => { primaryCloses += 1; },
          ensureStarted: async () => undefined,
        },
        additionalAppServers: [{
          isRunning: true,
          close: async () => { historyCloses += 1; },
          ensureStarted: async () => undefined,
        }],
        userDataPath: () => directory,
        isQuitting: () => false,
        emitStatus: () => undefined,
        notify: () => undefined,
        isCliInUse: async () => false,
        environment: {},
        operations: {
          readInstalledVersion: async () => installed,
          readLatestVersion: async () => "1.1.0",
          installVersion: async (version) => { installed = version; },
        },
      });

      await manager.check(true);
      assert.equal((await manager.update()).phase, "upToDate");
      assert.equal(primaryCloses, 1);
      assert.equal(historyCloses, 1);
      manager.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not block on pending work inside an AgentDesk app-server", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-codex-internal-busy-"));
    let installed = "1.0.0";
    let closes = 0;
    try {
      const appServer = {
        isRunning: true,
        isBusy: true,
        close: async () => { closes += 1; },
        ensureStarted: async () => undefined,
      };
      const manager = new CodexCliUpdateManager({
        processSupervisor: new ProcessSupervisor(async () => undefined),
        appServer,
        userDataPath: () => directory,
        isQuitting: () => false,
        emitStatus: () => undefined,
        notify: () => undefined,
        // This callback represents only external/user-owned CLI processes.
        isCliInUse: async () => false,
        environment: {},
        operations: {
          readInstalledVersion: async () => installed,
          readLatestVersion: async () => "1.1.0",
          installVersion: async (version) => { installed = version; },
        },
      });

      await manager.check(true);
      assert.equal((await manager.update()).phase, "upToDate");
      assert.equal(closes, 1);
      manager.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never terminates an external app-server", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-codex-terminate-failure-"));
    let installCount = 0;
    let installed = "1.0.0";
    try {
      const manager = new CodexCliUpdateManager({
        processSupervisor: new ProcessSupervisor(async () => undefined),
        appServer: { isRunning: false, close: async () => undefined, ensureStarted: async () => undefined },
        userDataPath: () => directory,
        isQuitting: () => false,
        emitStatus: () => undefined,
        notify: () => undefined,
        isCliInUse: async () => true,
        environment: {},
        operations: {
          readInstalledVersion: async () => installed,
          readLatestVersion: async () => "1.1.0",
          installVersion: async (version) => { installCount += 1; installed = version; },
        },
      });

      await manager.check(true);
      const status = await manager.update();

      assert.equal(status.phase, "error");
      assert.equal(installCount, 0);
      manager.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cancels updating when an AgentDesk app-server cannot close safely", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-codex-close-failure-"));
    let installed = "1.0.0";
    let terminated = 0;
    try {
      const manager = new CodexCliUpdateManager({
        processSupervisor: new ProcessSupervisor(async () => undefined),
        appServer: {
          isRunning: true,
          close: async () => { throw new Error("close failed"); },
          ensureStarted: async () => undefined,
        },
        userDataPath: () => directory,
        isQuitting: () => false,
        emitStatus: () => undefined,
        notify: () => undefined,
        isCliInUse: async () => false,
        environment: {},
        operations: {
          readInstalledVersion: async () => installed,
          readLatestVersion: async () => "1.1.0",
          installVersion: async (version) => { installed = version; },
        },
      });

      await manager.check(true);
      const status = await manager.update();

      assert.equal(status.phase, "error");
      assert.equal(terminated, 0);
      manager.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
