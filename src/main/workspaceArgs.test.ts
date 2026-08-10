import assert from "node:assert/strict";
import test from "node:test";
import { requestedProviderFromArgs, requestedWorkspaceFromArgs } from "./workspaceArgs";

const resolveDirectory = (value: string) => value.startsWith("D:\\target") ? value : null;

test("reads a packaged --cwd argument", () => {
  assert.equal(
    requestedWorkspaceFromArgs(["AgentDesk.exe", "--cwd", "D:\\target\\project"], resolveDirectory),
    "D:\\target\\project",
  );
});

test("skips Electron's app path inserted after --cwd", () => {
  assert.equal(
    requestedWorkspaceFromArgs([
      "electron.exe",
      "--user-data-dir=build/dev-profile",
      "--cwd",
      "D:\\source\\agentdesk\\",
      "D:\\target\\project",
    ], resolveDirectory),
    "D:\\target\\project",
  );
});

test("accepts --cwd=directory", () => {
  assert.equal(
    requestedWorkspaceFromArgs(["AgentDesk.exe", "--cwd=D:\\target\\project"], resolveDirectory),
    "D:\\target\\project",
  );
});

test("returns null when no valid directory follows --cwd", () => {
  assert.equal(requestedWorkspaceFromArgs(["AgentDesk.exe", "--cwd", "--flag"], resolveDirectory), null);
});

test("reads inline and separate Provider arguments", () => {
  assert.equal(requestedProviderFromArgs(["AgentDesk.exe", "--provider=claude"]), "claude");
  assert.equal(requestedProviderFromArgs(["AgentDesk.exe", "--provider", "codex"]), "codex");
});

test("normalizes Provider arguments and rejects unsupported values", () => {
  assert.equal(requestedProviderFromArgs(["AgentDesk.exe", "--provider=CLAUDE"]), "claude");
  assert.equal(requestedProviderFromArgs(["AgentDesk.exe", "--provider=openai"]), null);
  assert.equal(requestedProviderFromArgs(["AgentDesk.exe"]), null);
});
