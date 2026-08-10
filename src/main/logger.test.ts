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
      logger.log("info", "test.request", { cwd: "D:\\work", token: "secret-token", prompt: "private prompt" });
      await logger.flush();

      await assert.rejects(() => readFile(path.join(directory, "agentdesk-2026-08-03.ndjson"), "utf8"), /ENOENT/);
      assert.equal(await readFile(path.join(directory, "agentdesk-2026-08-04.ndjson"), "utf8"), "kept\n");
      const line = JSON.parse(await readFile(path.join(directory, "agentdesk-2026-08-10.ndjson"), "utf8")) as Record<string, any>;
      assert.equal(line.event, "test.request");
      assert.deepEqual(line.details.token, { redacted: true, length: 12 });
      assert.equal(line.details.prompt.kind, "text");
      assert.equal(line.details.cwd, "D:\\work");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
