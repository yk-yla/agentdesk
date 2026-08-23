import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_PREFERENCES, normalizeClaudeModelCache, normalizeLastPresentationModes, normalizePreferences, normalizeRecentCommandUsage, PreferencesStore } from "./preferencesStore";

async function withStore(run: (store: PreferencesStore, filePath: string) => void | Promise<void>) {
  const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-preferences-"));
  const filePath = path.join(directory, "preferences.json");
  try {
    await run(new PreferencesStore(() => filePath), filePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("PreferencesStore", () => {
  it("returns independent defaults for missing and malformed files", async () => {
    await withStore((store, filePath) => {
      const missing = store.read();
      missing.favoriteWorkspaces.push("mutated");
      assert.deepEqual(store.read(), DEFAULT_PREFERENCES);

      writeFileSync(filePath, "{broken", "utf8");
      assert.deepEqual(store.read(), DEFAULT_PREFERENCES);
      assert.equal(readdirSync(path.dirname(filePath)).some((name) => name.startsWith("preferences.json.corrupt=")), true);
    });
  });

  it("normalizes legacy and untrusted preference values", () => {
    assert.equal(normalizePreferences({ theme: "system" }).theme, "github-light");

    const preferences = normalizePreferences({
      theme: "graphite",
      sidebarWidth: 999,
      baseFontSize: 99,
      favoriteWorkspaces: Array.from({ length: 40 }, (_, index) => `favorite-${index}`),
      sessionAliases: { valid: "Title", empty: "", numeric: 1 },
      modelContextWindows: {
        valid: { tokens: 200_000, updatedAt: 2 },
        invalid: { tokens: -1, updatedAt: 1 },
      },
      lastReasoningEfforts: { codex: " xhigh ", claude: "high", unknown: "medium" },
      lastPresentationModes: { codex: "terminal", claude: "workbench", unknown: "terminal", invalid: "chat" },
      recentCommandUsage: { "command:status": 20, "skill:review": 30, invalid: -1, bad: "later" },
      codexCompactionCounts: {
        "codex:thread-1": { count: 12, eventIds: ["compact-1", "compact-2", "compact-1"], updatedAt: 100 },
        invalid: { count: -1, eventIds: [1] },
      },
      compactionCounts: {
        "claude:thread-2": { count: 8, eventIds: ["claude-compaction-1"], updatedAt: 200 },
      },
      workspaceState: [],
      ignored: "field",
    });

    assert.equal(preferences.theme, "github-light");
    assert.deepEqual(preferences.lastPresentationModes, { codex: "terminal", claude: "workbench" });
    assert.equal(preferences.sidebarWidth, 480);
    assert.equal(preferences.baseFontSize, 14);
    assert.equal(preferences.favoriteWorkspaces.length, 32);
    assert.deepEqual(preferences.sessionAliases, { valid: "Title" });
    assert.deepEqual(preferences.modelContextWindows, { valid: { tokens: 200_000, updatedAt: 2 } });
    assert.deepEqual(preferences.lastReasoningEfforts, { codex: "xhigh", claude: "high" });
    assert.deepEqual(preferences.lastPresentationModes, { codex: "terminal", claude: "workbench" });
    assert.deepEqual(preferences.recentCommandUsage, { "skill:review": 30, "command:status": 20 });
    assert.deepEqual(preferences.codexCompactionCounts, { "codex:thread-1": { count: 12, eventIds: ["compact-1", "compact-2"], updatedAt: 100 } });
    assert.deepEqual(preferences.compactionCounts, {
      "codex:thread-1": { count: 12, eventIds: ["compact-1", "compact-2"], updatedAt: 100 },
      "claude:thread-2": { count: 8, eventIds: ["claude-compaction-1"], updatedAt: 200 },
    });
    assert.equal(preferences.workspaceState, undefined);
    assert.equal("ignored" in preferences, false);
  });

  it("keeps recent command usage sorted and bounded", () => {
    assert.deepEqual(normalizeRecentCommandUsage({ "command:old": 1, "skill:new": 3, "command:middle": 2, invalid: 4 }), { "skill:new": 3, "command:middle": 2, "command:old": 1 });
  });

  it("normalizes the per-provider presentation mode preference", () => {
    assert.deepEqual(normalizeLastPresentationModes({ codex: "terminal", claude: "workbench", unknown: "terminal" }), {
      codex: "terminal",
      claude: "workbench",
    });
    assert.deepEqual(normalizeLastPresentationModes({ codex: "chat", claude: 1 }), { codex: "workbench", claude: "workbench" });
    assert.deepEqual(normalizeLastPresentationModes(null), { codex: "workbench", claude: "workbench" });
  });

  it("accepts only the three supported themes and migrates removed themes", async () => {
    const themes = ["github-light", "modern-dark", "github-dark-dimmed"] as const;
    for (const theme of themes) {
      assert.equal(normalizePreferences({ theme }).theme, theme);
    }
    for (const removedTheme of ["github-dark", "modern-light", "dracula", "night-owl"]) {
      assert.equal(normalizePreferences({ theme: removedTheme }).theme, "github-light");
    }

    await withStore(async (store) => {
      for (const theme of themes) {
        await store.write({ theme });
        assert.equal(store.read().theme, theme);
      }
    });
  });

  it("keeps only a recent bounded Claude model cache", () => {
    const now = Date.now();
    const cache = normalizeClaudeModelCache({
      schema: 2,
      claudeVersion: "1.2.3",
      updatedAt: now,
      models: [{ id: "sonnet", displayName: "Sonnet", description: "公开模型", efforts: ["medium"], defaultEffort: "medium", supportsImage: true }],
    }, now);
    assert.equal(cache?.claudeVersion, "1.2.3");
    assert.deepEqual(normalizeClaudeModelCache({ schema: 1, claudeVersion: "1.2.3", updatedAt: now, models: [{ id: "sonnet", displayName: "Sonnet" }] }, now), undefined);
    assert.deepEqual(normalizeClaudeModelCache({ schema: 2, claudeVersion: "1.2.3", updatedAt: now, models: [] }, now), undefined);
    assert.deepEqual(normalizeClaudeModelCache({ schema: 2, claudeVersion: "1.2.3", updatedAt: now - 15 * 24 * 60 * 60 * 1000, models: [{ id: "sonnet", displayName: "Sonnet" }] }, now), undefined);
    const preferences = normalizePreferences({ claudeModelCache: cache });
    assert.equal(preferences.claudeModelCache?.models[0]?.id, "sonnet");
  });

  it("merges, validates and atomically persists patches", async () => {
    await withStore(async (store, filePath) => {
      await store.write({ lastWorkspace: "first", theme: "modern-dark", lastReasoningEfforts: { codex: "xhigh", claude: "high" } });
      const result = await store.write({ lastWorkspace: "second", sidebarWidth: 100, baseFontSize: 13 });

      assert.equal(result.lastWorkspace, "second");
      assert.equal(result.theme, "modern-dark");
      assert.equal(result.sidebarWidth, 184);
      assert.equal(result.baseFontSize, 13);
      assert.deepEqual(result.lastReasoningEfforts, { codex: "xhigh", claude: "high" });
      assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), result);
    });
  });

  it("quarantines a corrupt file before writing new preferences", async () => {
    await withStore(async (store, filePath) => {
      writeFileSync(filePath, "{broken", "utf8");
      await store.write({ theme: "modern-dark" });

      assert.equal(JSON.parse(readFileSync(filePath, "utf8")).theme, "modern-dark");
      assert.equal(readdirSync(path.dirname(filePath)).some((name) => name.startsWith("preferences.json.corrupt=")), true);
    });
  });

  it("serializes concurrent patches without losing fields", async () => {
    await withStore(async (store) => {
      await Promise.all([
        store.write({ lastWorkspace: "concurrent-workspace" }),
        store.write({ theme: "modern-dark" }),
      ]);

      const result = store.read();
      assert.equal(result.lastWorkspace, "concurrent-workspace");
      assert.equal(result.theme, "modern-dark");
    });
  });

  it("rejects writes and quarantines files above the 4 MB limit", async () => {
    await withStore(async (store, filePath) => {
      await assert.rejects(
        store.write({ workspaceState: { draft: "x".repeat(4 * 1024 * 1024) } }),
        /本地偏好数据过大/,
      );
      writeFileSync(filePath, " ".repeat(4 * 1024 * 1024 + 1), "utf8");
      assert.deepEqual(store.read(), DEFAULT_PREFERENCES);
      assert.equal(readdirSync(path.dirname(filePath)).some((name) => name.startsWith("preferences.json.corrupt=")), true);
    });
  });
});
