import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildDiagnosticBundle } from "./diagnostics";

describe("diagnostic export", () => {
  it("keeps useful metadata while removing secrets, paths, and user text", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agentdesk-diagnostics-"));
    try {
      await writeFile(path.join(directory, "agentdesk-2026-08-10.ndjson"), [
        JSON.stringify({ timestamp: "2026-08-10T12:00:00.000Z", level: "error", event: "ui.failure", processId: 42, appRunId: "run-1", details: { workspace: "D:\\private\\project", cwd: "D:\\private\\project", prompt: "用户输入内容", token: "secret", source: "https://user:pass@example.invalid/log?access_token=secret" } }),
        "not json",
      ].join("\n"));

      const result = JSON.parse(await buildDiagnosticBundle(directory, { workspace: "D:\\private\\project", version: "1.0.0" })) as { metadata: Record<string, unknown>; logs: Array<Record<string, any>> };
      assert.equal(result.logs.length, 1);
      assert.equal(result.logs[0].details.workspace.kind, "path");
      assert.equal(result.logs[0].details.workspace.basename, "project");
      assert.match(result.logs[0].details.workspace.sha256, /^[0-9a-f]{16}$/);
      assert.equal(result.logs[0].details.prompt.kind, "text");
      assert.equal(result.logs[0].details.prompt.length, 6);
      assert.match(result.logs[0].details.prompt.sha256, /^[0-9a-f]{16}$/);
      assert.deepEqual(result.logs[0].details.token, { redacted: true, length: 6 });
      assert.match(result.logs[0].details.source, /access_token=%5Bredacted%5D/);
      assert.equal((result.metadata.workspace as Record<string, unknown>).basename, "project");
      assert.equal(result.logs[0].appRunId, "run-1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
