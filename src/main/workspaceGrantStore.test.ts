import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { WorkspaceGrantStore } from "./workspaceGrantStore";

describe("WorkspaceGrantStore", () => {
  it("persists only bounded, unique main-process grants", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-workspace-grants-"));
    try {
      const filePath = path.join(directory, "workspace-grants.json");
      const store = new WorkspaceGrantStore(() => filePath, 2);
      await store.grant("D:\\one");
      await store.grant("D:\\two");
      await store.grant("D:\\one");
      await store.grant("D:\\three");
      assert.deepEqual(store.read(), ["D:\\three", "D:\\one"]);
      assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), ["D:\\three", "D:\\one"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed and quarantines malformed or oversized grant files", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-workspace-grants-"));
    try {
      const filePath = path.join(directory, "workspace-grants.json");
      const store = new WorkspaceGrantStore(() => filePath, 2);
      writeFileSync(filePath, "not json");
      await assert.rejects(store.grant("D:\\one"), /文件损坏/);
      assert.equal(existsSync(filePath), false);
      assert.equal(readdirSync(directory).some((name) => name.startsWith("workspace-grants.json.corrupt=")), true);
      writeFileSync(filePath, "x".repeat(64 * 1024 + 1));
      assert.deepEqual(store.read(), []);
      assert.equal(existsSync(filePath), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
