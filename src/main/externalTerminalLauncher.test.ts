import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExternalTerminalLaunchPlan, expandExternalTerminalArgs } from "./externalTerminalLauncher";

describe("external terminal launcher", () => {
  it("passes a handoff prompt to PowerShell as a single decoded argument", () => {
    const args = expandExternalTerminalArgs({
      kind: "windows-terminal",
      executable: "wt.exe",
      argsTemplate: '-d "{cwd}" powershell.exe -NoExit -Command "claude --session-id {sessionId} {prompt}"',
    }, "C:\\Apps\\wt.exe", {
      cwd: "C:\\work folder",
      sessionId: "12345678-1234-4234-8234-123456789abc",
      resume: false,
      initialPrompt: "请读取交接文件并继续任务。",
    });

    assert.deepEqual(args.slice(0, -1), ["-d", "C:\\work folder", "powershell.exe", "-NoExit", "-Command"]);
    const command = args.at(-1)!;
    assert.match(command, /^claude --session-id 12345678-1234-4234-8234-123456789abc /);
    const promptMatch = command.match(/FromBase64String\('([^']+)'\)/);
    assert.ok(promptMatch);
    assert.equal(Buffer.from(promptMatch[1], "base64").toString("utf8"), "请读取交接文件并继续任务。");
  });

  it("keeps command prompt handoff text as one Claude argument", () => {
    const args = expandExternalTerminalArgs({
      kind: "command-prompt",
      executable: "cmd.exe",
      argsTemplate: '/k "claude --session-id {sessionId} {prompt}"',
    }, "C:\\Windows\\System32\\cmd.exe", {
      cwd: "C:\\work",
      sessionId: "12345678-1234-4234-8234-123456789abc",
      resume: false,
      initialPrompt: "请继续任务。",
    });

    assert.equal(args[0], "/k");
    const encodedCommand = args[1].split(" ").at(-1)!;
    const command = Buffer.from(encodedCommand, "base64").toString("utf16le");
    assert.match(command, /claude --session-id '12345678-1234-4234-8234-123456789abc'/);
    const promptMatch = command.match(/FromBase64String\('([^']+)'\)/);
    assert.ok(promptMatch);
    assert.equal(Buffer.from(promptMatch[1], "base64").toString("utf8"), "请继续任务。");
  });

  it("upgrades legacy templates that do not yet have a prompt placeholder", () => {
    const args = expandExternalTerminalArgs({
      kind: "custom",
      executable: "custom-terminal.exe",
      argsTemplate: 'claude --session-id {sessionId}',
    }, "C:\\Tools\\custom-terminal.exe", {
      cwd: "C:\\work",
      sessionId: "12345678-1234-4234-8234-123456789abc",
      resume: false,
      initialPrompt: "handoff",
    });
    assert.deepEqual(args, ["claude", "--session-id", "12345678-1234-4234-8234-123456789abc", "([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('aGFuZG9mZg==')))"]);
  });

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
