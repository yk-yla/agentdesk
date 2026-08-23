import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseClaudeTerminalInput, parseClaudeTerminalSettings } from "./terminalSettings";

describe("Claude terminal settings", () => {
  it("reads the actual model and effort from the CLI status bar", () => {
    const result = parseClaudeTerminalSettings("\u001b[90m[tools/agentdesk | Opus 4.6 (1M context) | ctx:0k]\u001b[0m\r\nxhigh · /effort");
    assert.deepEqual(result.settings, { model: "claude-opus-4-6[1m]", effort: "xhigh" });
  });

  it("handles a status line split across terminal output events", () => {
    const first = parseClaudeTerminalSettings("[tools/agentdesk | Opus 4.6 (1M ");
    const second = parseClaudeTerminalSettings("context) | ctx:0k]\r\nxhigh · /effort", first.buffer);
    assert.deepEqual(second.settings, { model: "claude-opus-4-6[1m]", effort: "xhigh" });
  });

  it("reads the effort label shown by Claude's model picker", () => {
    assert.equal(parseClaudeTerminalSettings("High effort (default) <-/-> to adjust").settings.effort, "high");
    assert.equal(parseClaudeTerminalSettings("medium effort").settings.effort, "medium");
    assert.equal(parseClaudeTerminalSettings("xhigh effort (default)").settings.effort, "xhigh");
  });

  it("maps the built-in model labels to stable SDK aliases", () => {
    assert.equal(parseClaudeTerminalSettings("> 1. Default (recommended) ✓\r\n").settings.model, "default");
    assert.equal(parseClaudeTerminalSettings("> 2. Opus (1M context) ✓\r\n").settings.model, "opus[1m]");
    assert.equal(parseClaudeTerminalSettings("> 4. Sonnet 5 (1M context) ✓\r\n").settings.model, "sonnet[1m]");
    assert.equal(parseClaudeTerminalSettings("> 5. Haiku ✓\r\n").settings.model, "haiku");
    assert.equal(parseClaudeTerminalSettings("> 1. Default (recommended)\r\n  6. Opus 4.6 (1M context) ✓\r\n").settings.model, "claude-opus-4-6[1m]");
    assert.deepEqual(parseClaudeTerminalSettings("[tools/agentdesk | Opus 5 (1M context) | ctx:0k]").settings, {});
  });

  it("captures a manually entered full or legacy model ID", () => {
    const first = parseClaudeTerminalInput("/model claude-opus-4-6[1m]");
    const second = parseClaudeTerminalInput("\r", first.buffer);
    assert.equal(second.settings.model, "claude-opus-4-6[1m]");
    const legacy = parseClaudeTerminalInput("/model claude-opus-4-5");
    assert.equal(parseClaudeTerminalInput("\r", legacy.buffer).settings.model, "claude-opus-4-5");
  });

  it("keeps unrelated terminal text out of the settings", () => {
    assert.deepEqual(parseClaudeTerminalSettings("The model is high and the task is complete.").settings, {});
  });
});
