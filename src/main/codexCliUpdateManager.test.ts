import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { CodexCliUpdateStatus } from "../shared/protocol";
import { CodexCliUpdateManager, compareVersions, findCodexAppServerRoots } from "./codexCliUpdateManager";
import { ProcessSupervisor } from "./processSupervisor";

describe("CodexCliUpdateManager", () => {
  it("compares releases and finds the outer app-server process root", () => {
    assert.equal(compareVersions("1.2.4", "1.2.3") > 0, true);
    assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
    const roots = findCodexAppServerRoots([
      { pid: 1, parentPid: 0, name: "cmd.exe", commandLine: "codex.cmd app-server" },
      { pid: 2, parentPid: 1, name: "node.exe", commandLine: "@openai/codex app-server" },
      { pid: 3, parentPid: 0, name: "node.exe", commandLine: "unrelated.js" },
      { pid: 4, parentPid: 0, name: "node.exe", commandLine: "feishu-codex-bridge.js --app-server" },
    ]);
    assert.deepEqual(roots.map((entry) => entry.pid), [1, 4]);
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
        environment: {},
        operations: {
          readInstalledVersion: async () => installed,
          readLatestVersion: async () => "1.1.0",
          installVersion: async (version) => { installed = version; },
          readAppServerProcesses: async () => [],
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

  it("terminates external app-servers before updating", async () => {
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
        environment: {},
        operations: {
          readInstalledVersion: async () => installed,
          readLatestVersion: async () => "1.1.0",
          installVersion: async (version) => { installCount += 1; installed = version; },
          readAppServerProcesses: async () => [
            { pid: 9001, parentPid: 0, name: "codex.exe", commandLine: "codex.exe app-server" },
            { pid: 9004, parentPid: 0, name: "node.exe", commandLine: "feishu-bridge --app-server" },
          ],
          terminateAppServerProcess: async (pid) => { terminated.push(pid); },
        },
      });

      await manager.check(true);
      const status = await manager.update();

      assert.equal(status.phase, "upToDate");
      assert.equal(closeCount, 1);
      assert.equal(installCount, 1);
      assert.deepEqual(terminated, [9001, 9004]);
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
        environment: {},
        operations: {
          readInstalledVersion: async () => installed,
          readLatestVersion: async () => "1.1.0",
          installVersion: async (version) => { installed = version; },
          readAppServerProcesses: async () => [],
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

  it("continues updating when an external app-server cannot be terminated", async () => {
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
        environment: {},
        operations: {
          readInstalledVersion: async () => installed,
          readLatestVersion: async () => "1.1.0",
          installVersion: async (version) => { installCount += 1; installed = version; },
          readAppServerProcesses: async () => [{ pid: 9002, parentPid: 0, name: "node.exe", commandLine: "bridge --app-server" }],
          terminateAppServerProcess: async () => { throw new Error("access denied"); },
        },
      });

      await manager.check(true);
      const status = await manager.update();

      assert.equal(status.phase, "upToDate");
      assert.equal(installCount, 1);
      manager.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("continues updating when AgentDesk app-server graceful close fails", async () => {
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
        environment: {},
        operations: {
          readInstalledVersion: async () => installed,
          readLatestVersion: async () => "1.1.0",
          installVersion: async (version) => { installed = version; },
          readAppServerProcesses: async () => [{ pid: 9003, parentPid: 0, name: "node.exe", commandLine: "codex app-server" }],
          terminateAppServerProcess: async () => { terminated += 1; },
        },
      });

      await manager.check(true);
      const status = await manager.update();

      assert.equal(status.phase, "upToDate");
      assert.equal(terminated, 1);
      manager.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
