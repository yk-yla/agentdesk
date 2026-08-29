import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { CodexHistoryIndex } from "./codexHistoryIndex";

const SESSION_ID = "01a01d46-57dc-74e1-a579-95d100691add";

function sessionLine(type: string, payload: unknown, timestamp: string) {
  return JSON.stringify({ type, payload, timestamp });
}

describe("CodexHistoryIndex", () => {
  it("indexes conversation text and updates only changed files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentdesk-codex-index-"));
    const sessions = path.join(root, "sessions", "2026", "08");
    const filePath = path.join(sessions, `rollout-2026-08-28T11-45-44-${SESSION_ID}.jsonl`);
    const storagePath = path.join(root, "index.json");
    try {
      await mkdir(sessions, { recursive: true });
      await writeFile(filePath, [
        sessionLine("turn_context", { cwd: "E:\\whaty\\help" }, "2026-08-28T03:45:44.000Z"),
        sessionLine("response_item", { type: "message", content: [{ type: "input_text", text: "xm_paike_new.sql" }] }, "2026-08-28T03:45:45.000Z"),
      ].join("\n"), "utf8");
      const index = new CodexHistoryIndex({ roots: [path.join(root, "sessions")], storagePath: () => storagePath, isWorkspaceAuthorized: () => true, startDelayMs: 60_000 });
      await index.refreshNow();
      const first = await index.search({ cwd: "E:\\whaty\\help", searchTerm: "xm_paike_new.sql", limit: 10 });
      assert.equal(first.data.length, 1);
      assert.equal((first.data[0] as { thread: { id: string } }).thread.id, SESSION_ID);

      await writeFile(filePath, [
        sessionLine("turn_context", { cwd: "E:\\whaty\\help" }, "2026-08-28T03:45:44.000Z"),
        sessionLine("response_item", { type: "message", content: [{ type: "input_text", text: "different-file-name.sql" }] }, "2026-08-28T03:45:45.000Z"),
      ].join("\n"), "utf8");
      await index.refreshNow();
      assert.equal((await index.search({ cwd: "E:\\whaty\\help", searchTerm: "xm_paike_new.sql" })).data.length, 0);
      assert.equal((await index.search({ cwd: "E:\\whaty\\help", searchTerm: "different-file-name.sql" })).data.length, 1);

      await rm(filePath);
      await index.refreshNow();
      assert.equal((await index.search({ cwd: "E:\\whaty\\help", searchTerm: "different-file-name.sql" })).data.length, 0);

      await index.close();
      assert.doesNotMatch(await readFile(storagePath, "utf8"), /different-file-name\.sql/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not return entries without an authorized workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentdesk-codex-index-"));
    const sessions = path.join(root, "sessions");
    const filePath = path.join(sessions, `rollout-2026-08-28T11-45-44-${SESSION_ID}.jsonl`);
    try {
      await mkdir(sessions, { recursive: true });
      await writeFile(filePath, sessionLine("turn_context", { cwd: "E:\\private" }, "2026-08-28T03:45:44.000Z") + "\n" + sessionLine("response_item", { content: [{ text: "private keyword" }] }, "2026-08-28T03:45:45.000Z"), "utf8");
      const index = new CodexHistoryIndex({ roots: [path.join(root, "sessions")], storagePath: () => path.join(root, "index.json"), isWorkspaceAuthorized: () => false });
      await index.refreshNow();
      assert.equal((await index.search({ allWorkspaces: true, searchTerm: "private keyword" })).data.length, 0);
      await index.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
