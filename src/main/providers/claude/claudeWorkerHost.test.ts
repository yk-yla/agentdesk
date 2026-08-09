import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ClaudeWorkerHost } from "./claudeWorkerHost";

describe("ClaudeWorkerHost", () => {
  it("closes a lifecycle fixture process tree with its Query", async () => {
    const workerFile = path.resolve(process.cwd(), "build", "electron", "main", "providers", "claude", "claudeWorker.mjs");
    const host = new ClaudeWorkerHost(() => workerFile);
    const sessionId = "lifecycle-process-tree";
    const queryGeneration = 1;
    const rootPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture process did not start")), 5_000);
      const unsubscribe = host.subscribe((event) => {
        if (event.type !== "processStarted" || event.sessionId !== sessionId) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(event.rootPid);
      });
      host.send({
        type: "start",
        sessionId,
        nativeSessionId: "77777777-7777-4777-8777-777777777777",
        queryGeneration,
        cwd: process.cwd(),
        prompt: "fixture",
        settingSources: [],
        gatewayFixture: { kind: "offline", lifecycle: "longBash" },
      });
    });
    assert.ok(rootPid > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.kill(rootPid, 0);
    await host.closeSession(sessionId, queryGeneration);
    await assert.rejects(async () => process.kill(rootPid, 0));
    await host.close();
  });

  it("rejects every pending request once when a worker exits and recreates it", async (test) => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-worker-host-"));
    test.after(() => rmSync(directory, { recursive: true, force: true }));
    const marker = path.join(directory, "marker");
    const workerFile = path.join(directory, "worker.mjs");
    writeFileSync(workerFile, `
      import { parentPort } from "node:worker_threads";
      import { existsSync, writeFileSync } from "node:fs";
      const marker = ${JSON.stringify(marker)};
      let pendingCount = 0;
      parentPort.on("message", message => {
        if (!existsSync(marker)) {
          pendingCount += 1;
          if (pendingCount === 2) {
            writeFileSync(marker, "failed");
            setTimeout(() => process.exit(7), 10);
          }
          return;
        }
        parentPort.postMessage({ type: "response", requestId: message.requestId, result: { ok: true } });
      });
    `);
    const host = new ClaudeWorkerHost(() => workerFile);
    const fatals: string[] = [];
    host.subscribe((event) => { if (event.type === "fatal") fatals.push(event.message); });
    const first = host.request({ type: "listSessions", cwd: directory, limit: 1, offset: 0, includeWorktrees: false });
    const second = host.request({ type: "listSessions", cwd: directory, limit: 1, offset: 1, includeWorktrees: false });
    await assert.rejects(first, /异常退出/);
    await assert.rejects(second, /异常退出/);
    assert.equal(fatals.length, 1);
    assert.deepEqual(await host.request({ type: "listSessions", cwd: directory, limit: 1, offset: 0, includeWorktrees: false }), { ok: true });
    await host.close();
  });

  it("lets a fatal worker finish cleanup before forcing termination", async (test) => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-worker-fatal-"));
    test.after(() => rmSync(directory, { recursive: true, force: true }));
    const marker = path.join(directory, "cleanup-complete");
    const workerFile = path.join(directory, "worker.mjs");
    writeFileSync(workerFile, `
      import { parentPort } from "node:worker_threads";
      import { writeFileSync } from "node:fs";
      const marker = ${JSON.stringify(marker)};
      parentPort.on("message", message => {
        if (message.type !== "testFatal") return;
        parentPort.postMessage({ type: "fatal", message: message.message });
        setTimeout(() => {
          writeFileSync(marker, "done");
          process.exit(9);
        }, 50);
      });
    `);
    const host = new ClaudeWorkerHost(() => workerFile);
    const pending = host.request({ type: "listSessions", cwd: directory, limit: 1, offset: 0, includeWorktrees: false });
    host.injectFatalForTesting("fixture fatal");
    await assert.rejects(pending, /fixture fatal/);
    const deadline = Date.now() + 2_000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(marker), true);
    await host.close();
  });
});
