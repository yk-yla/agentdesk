import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExternalTerminalLaunchPlan } from "./externalTerminalLauncher";

describe("external terminal launcher", () => {
  it("launches Windows Terminal directly", () => {
    const plan = createExternalTerminalLaunchPlan({
      kind: "windows-terminal",
      executable: "wt.exe",
      argsTemplate: "unused",
    }, "C:\\Apps\\wt.exe", ["-d", "C:\\work"], "C:\\work");

    assert.deepEqual(plan, {
      executable: "C:\\Apps\\wt.exe",
      args: ["-d", "C:\\work"],
      mode: "direct",
    });
  });

  it("uses a visible console launcher for PowerShell 7", () => {
    const plan = createExternalTerminalLaunchPlan({
      kind: "powershell-7",
      executable: "pwsh.exe",
      argsTemplate: "unused",
    }, "C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoExit", "-Command", "claude --session-id session-1"], "C:\\work folder");

    assert.equal(plan.executable, "powershell.exe");
    assert.equal(plan.mode, "visible-console");
    assert.deepEqual(plan.args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand"]);
    const script = Buffer.from(plan.args.at(-1)!, "base64").toString("utf16le");
    const payloadMatch = script.match(/FromBase64String\('([^']+)'\)/u);
    assert.ok(payloadMatch);
    const payload = JSON.parse(Buffer.from(payloadMatch[1], "base64").toString("utf8")) as Record<string, string>;
    assert.equal(payload.executable, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    assert.equal(payload.arguments, '-NoExit -Command "claude --session-id session-1"');
    assert.equal(payload.cwd, "C:\\work folder");
  });

  it("also protects custom configurations that directly target a console shell", () => {
    const plan = createExternalTerminalLaunchPlan({
      kind: "custom",
      executable: "C:\\Tools\\pwsh.exe",
      argsTemplate: "unused",
    }, "C:\\Tools\\pwsh.exe", ["-NoExit"], "C:\\work");

    assert.equal(plan.mode, "visible-console");
  });
});
