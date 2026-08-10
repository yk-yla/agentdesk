import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { launchWindowsTerminal, type WindowsTerminalSpawner } from "./windowsTerminal";

describe("Windows Terminal launcher", () => {
  it("launches WT visibly in the requested directory", () => {
    let invocation: Parameters<WindowsTerminalSpawner> | undefined;
    let unrefCalled = false;
    const spawnProcess: WindowsTerminalSpawner = (...args) => {
      invocation = args;
      return { unref: () => { unrefCalled = true; } };
    };

    launchWindowsTerminal("D:\\workspace", spawnProcess);

    assert.deepEqual(invocation, ["wt.exe", ["-d", "D:\\workspace"], {
      detached: true,
      windowsHide: false,
      shell: false,
      stdio: "ignore",
    }]);
    assert.equal(unrefCalled, true);
  });
});
