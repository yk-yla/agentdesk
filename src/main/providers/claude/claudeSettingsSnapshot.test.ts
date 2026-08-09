import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeSettingsSnapshot } from "./claudeSettingsSnapshot";

describe("Claude settings snapshot", () => {
  it("freezes the official project settings resolution for a Query", async (test) => {
    const root = mkdtempSync(path.join(tmpdir(), "agentdesk-settings-snapshot-"));
    test.after(() => rmSync(root, { recursive: true, force: true }));
    const configDir = path.join(root, ".claude");
    mkdirSync(configDir);
    const settingsPath = path.join(configDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ language: "snapshot-before" }));
    const resolved = await resolveSettings({ cwd: root, settingSources: ["project"] });
    const snapshot = await createClaudeSettingsSnapshot(resolved.effective);
    writeFileSync(settingsPath, JSON.stringify({ language: "snapshot-after" }));
    const snapshotValue = JSON.parse(readFileSync(snapshot.path, "utf8")) as { language?: string };
    assert.equal(snapshotValue.language, "snapshot-before");
    assert.equal(snapshot.path.includes("snapshot-before"), false);
    await snapshot.dispose();
    assert.equal(existsSync(snapshot.path), false);
    await snapshot.dispose();
  });
});
