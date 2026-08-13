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
    ]);
    assert.deepEqual(roots.map((entry) => entry.pid), [1]);
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

  it("blocks updates without terminating an external app-server", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-codex-external-"));
    let closeCount = 0;
    let installCount = 0;
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
          ],
        },
      });

      await manager.check(true);
      const status = await manager.update();

      assert.equal(status.phase, "error");
      assert.match(status.message, /非 AgentDesk 启动/);
      assert.equal(closeCount, 1);
      assert.equal(installCount, 0);
      manager.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
