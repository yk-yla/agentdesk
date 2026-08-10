import { spawn, type SpawnOptions } from "node:child_process";

export type WindowsTerminalSpawner = (command: string, args: string[], options: SpawnOptions) => { unref(): void };

export function launchWindowsTerminal(directory: string, spawnProcess: WindowsTerminalSpawner = spawn) {
  const child = spawnProcess("wt.exe", ["-d", directory], {
    detached: true,
    windowsHide: false,
    shell: false,
    stdio: "ignore",
  });
  child.unref();
}
