import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Settings } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeSettingsSnapshot {
  path: string;
  dispose(): Promise<void>;
}

/** Keep resolved settings out of process arguments while freezing one Query's configuration. */
export async function createClaudeSettingsSnapshot(settings: Settings): Promise<ClaudeSettingsSnapshot> {
  const directory = await mkdtemp(path.join(tmpdir(), "agentdesk-claude-settings-"));
  const snapshotPath = path.join(directory, "settings.json");
  try {
    await writeFile(snapshotPath, JSON.stringify(settings), { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  let disposed = false;
  return {
    path: snapshotPath,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
