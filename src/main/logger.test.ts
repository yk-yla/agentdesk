import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FileLogger } from "./logger";

describe("FileLogger", () => {
  it("writes structured redacted logs and removes files older than seven days", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agentdesk-logger-"));
    try {
      await writeFile(path.join(directory, "agentdesk-2026-08-03.ndjson"), "old\n");
      await writeFile(path.join(directory, "agentdesk-2026-08-04.ndjson"), "kept\n");
      const logger = new FileLogger(() => directory, () => new Date("2026-08-10T12:00:00.000Z"));
      logger.log("info", "test.request", { cwd: "D:\\work", token: "secret-token", prompt: "private prompt", delta: "terminal output" });
      logger.log("info", "marketplace.request", { source: "https://user:pass@example.invalid/marketplace.json?access_token=secret" });
      await logger.flush();

      await assert.rejects(() => readFile(path.join(directory, "agentdesk-2026-08-03.ndjson"), "utf8"), /ENOENT/);
      assert.equal(await readFile(path.join(directory, "agentdesk-2026-08-04.ndjson"), "utf8"), "kept\n");
      const logLines = (await readFile(path.join(directory, "agentdesk-2026-08-10.ndjson"), "utf8")).trim().split("\n");
      const line = JSON.parse(logLines[0]) as Record<string, any>;
      assert.equal(line.event, "test.request");
      assert.deepEqual(line.details.token, { redacted: true, length: 12 });
      assert.equal(line.details.prompt.kind, "text");
      assert.equal(line.details.delta.kind, "text");
      assert.equal(line.details.cwd, "D:\\work");
      const marketplaceLine = JSON.parse(logLines[1]) as Record<string, any>;
      assert.equal(marketplaceLine.details.source, "https://example.invalid/marketplace.json?access_token=%5B%E5%B7%B2%E8%84%B1%E6%95%8F%5D");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("skips debug logs unless explicitly enabled", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agentdesk-logger-debug-"));
    const previous = process.env.AGENTDESK_DEBUG_LOGS;
    try {
      delete process.env.AGENTDESK_DEBUG_LOGS;
      const logger = new FileLogger(() => directory, () => new Date("2026-08-10T12:00:00.000Z"));
      logger.log("debug", "provider.event", { delta: "private output" });
      logger.log("info", "ui.message.send", { provider: "codex" });
      await logger.flush();

      const lines = (await readFile(path.join(directory, "agentdesk-2026-08-10.ndjson"), "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]).event, "ui.message.send");
    } finally {
      if (previous === undefined) delete process.env.AGENTDESK_DEBUG_LOGS;
      else process.env.AGENTDESK_DEBUG_LOGS = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
