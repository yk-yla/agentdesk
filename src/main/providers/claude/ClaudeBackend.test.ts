import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeBackend, CLAUDE_TRUST_REQUIRED_PREFIX, type ClaudeWorkerRuntime } from "./ClaudeBackend";
import type { ClaudeWorkerCommand, ClaudeWorkerEvent } from "./claudeWorkerProtocol";
import type { AgentEventEnvelope } from "../../../shared/agentProtocol";

class FakeRuntime implements ClaudeWorkerRuntime {
  commands: ClaudeWorkerCommand[] = [];
  requests: ClaudeWorkerCommand[] = [];
  known = new Map<string, string>();
  listener: ((event: ClaudeWorkerEvent) => void) | null = null;
  searchResult: unknown = { data: [], scannedCount: 0, hasMore: false };
  failControl = new Set<string>();
  unsupportedControl = new Set<string>();
  send(command: ClaudeWorkerCommand) { this.commands.push(command); }
  async request(command: Exclude<ClaudeWorkerCommand, { type: "start" | "send" | "interrupt" | "closeSession" | "testHoldRequests" | "testFatal" | "close" }>) {
    this.requests.push(command);
    if (command.type === "getSessionInfo") {
      const cwd = this.known.get(command.nativeSessionId);
      return cwd === command.cwd ? { id: command.nativeSessionId, cwd } : null;
    }
    if (command.type === "forkSession") {
      const id = "33333333-3333-4333-8333-333333333333";
      this.known.set(id, command.cwd);
      return { sessionId: id };
    }
    if (command.type === "searchSessions") return this.searchResult;
    if (command.type === "control") {
      if (this.unsupportedControl.has(command.action)) throw new Error(`${command.action} is not supported`);
      if (this.failControl.has(command.action)) throw new Error(`${command.action} temporarily unavailable`);
      if (command.action === "models") return [{ value: "claude-test", supportedEffortLevels: ["medium"] }];
      if (command.action === "commands") return [{ name: "review" }, { name: "compact" }];
      if (command.action === "agents") return [{ name: "worker" }];
      return {};
    }
    return { data: [], hasMore: false };
  }
  subscribe(listener: (event: ClaudeWorkerEvent) => void) { this.listener = listener; return () => { this.listener = null; }; }
  async close() {}
}

const fixtureCredentials = () => ({ source: "settings" as const, baseUrl: "https://example.invalid", authToken: "fixture-token" });

function testBackend(runtime: FakeRuntime, timeoutMs = 300_000) {
  return new ClaudeBackend(runtime, timeoutMs, undefined, fixtureCredentials);
}

async function activeBackend(timeoutMs = 300_000) {
  const runtime = new FakeRuntime();
  const backend = testBackend(runtime, timeoutMs);
  const sessionId = `client-${Math.random().toString(36).slice(2)}`;
  await backend.request("startSession", { cwd: process.cwd(), trustWorkspace: true }, { sessionId, canonicalCwd: process.cwd() });
  await backend.request("startTurn", { input: [{ type: "text", text: "test" }] }, { sessionId, canonicalCwd: process.cwd() });
  const start = runtime.commands.find((command): command is Extract<ClaudeWorkerCommand, { type: "start" }> => command.type === "start");
  assert.ok(start);
  return { backend, runtime, sessionId, generation: start.queryGeneration };
}

describe("ClaudeBackend", () => {
  it("requires explicit workspace trust before creating a session", async () => {
    const backend = testBackend(new FakeRuntime());
    await assert.rejects(
      backend.request("startSession", { cwd: process.cwd() }, { sessionId: "client-1", canonicalCwd: process.cwd() }),
      (error: Error) => error.message.startsWith(CLAUDE_TRUST_REQUIRED_PREFIX),
    );
    const result = await backend.request("startSession", { cwd: process.cwd(), trustWorkspace: true }, { sessionId: "client-1", canonicalCwd: process.cwd() });
    assert.ok((result as { thread: { id: string } }).thread.id);
    await backend.close();
  });

  it("does not leave a failed credential check marked as an active Query", async () => {
    const runtime = new FakeRuntime();
    let rejectCredentials = true;
    const backend = new ClaudeBackend(runtime, undefined, undefined, () => {
      if (rejectCredentials) throw new Error("fixture credentials rejected");
      return { source: "settings", baseUrl: "https://example.invalid", authToken: "fixture-token" };
    });
    const sessionId = "credential-retry";
    const cwd = process.cwd();
    await backend.request("startSession", { cwd, trustWorkspace: true }, { sessionId, canonicalCwd: cwd });
    await assert.rejects(backend.request("startTurn", { input: [{ type: "text", text: "first" }] }, { sessionId, canonicalCwd: cwd }), /fixture credentials rejected/);
    rejectCredentials = false;
    await backend.request("startTurn", { input: [{ type: "text", text: "retry" }] }, { sessionId, canonicalCwd: cwd });
    assert.equal(runtime.commands.filter((command) => command.type === "start").length, 1);
    await backend.close();
  });

  it("applies settings selected before the first Query starts", async () => {
    const runtime = new FakeRuntime();
    const backend = testBackend(runtime);
    const sessionId = "settings-before-query";
    const cwd = process.cwd();
    await backend.request("startSession", { cwd, trustWorkspace: true }, { sessionId, canonicalCwd: cwd });
    await backend.request("updateSessionSettings", { model: "sonnet", effort: "high" }, { sessionId, canonicalCwd: cwd });
    assert.equal(runtime.requests.filter((command) => command.type === "control").length, 0);

    await backend.request("startTurn", { input: [{ type: "text", text: "first" }] }, { sessionId, canonicalCwd: cwd });
    const start = runtime.commands.at(-1) as Extract<ClaudeWorkerCommand, { type: "start" }>;
    assert.equal(start.model, "sonnet");
    assert.equal(start.effort, "high");
    await backend.close();
  });

  it("rejects forged and cross-workspace native session references", async () => {
    const runtime = new FakeRuntime();
    const backend = testBackend(runtime);
    const first = path.resolve(process.cwd());
    const second = path.resolve(process.cwd(), "..");
    const nativeSessionId = "11111111-1111-4111-8111-111111111111";
    runtime.known.set(nativeSessionId, first);
    await assert.rejects(() => backend.request("readSession", { cwd: first, threadId: "forged" }, {}), /原生会话 ID 无效/);
    await assert.rejects(() => backend.request("readSession", { cwd: second, threadId: nativeSessionId }, {}), /不存在或不属于当前工作区/);
    await backend.close();
  });

  it("canonicalizes a workspace symlink before checking ownership", async (test) => {
    const root = mkdtempSync(path.join(tmpdir(), "agentdesk-claude-scope-"));
    test.after(() => rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    mkdirSync(target);
    symlinkSync(target, link, "junction");
    const nativeSessionId = "22222222-2222-4222-8222-222222222222";
    const runtime = new FakeRuntime();
    runtime.known.set(nativeSessionId, target);
    const backend = testBackend(runtime);
    await backend.request("readSession", { cwd: link, threadId: nativeSessionId }, {});
    assert.equal((runtime.requests.at(-1) as { cwd?: string }).cwd, target);
    await backend.close();
  });

  it("settles permission interactions once and applies SDK permission suggestions", async () => {
    const { backend, runtime, sessionId, generation } = await activeBackend();
    const events: AgentEventEnvelope[] = [];
    backend.subscribeEvents((event) => events.push(event));
    const pending: ClaudeWorkerEvent = {
      type: "interactionPending",
      sessionId,
      queryGeneration: generation,
      interactionId: "permission:req-1",
      kind: "permission",
      payload: {
        requestId: "req-1",
        toolUseId: "tool-1",
        toolName: "Bash",
        input: { command: "echo ok" },
        suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }],
      },
    };
    runtime.listener?.(pending);
    runtime.listener?.(pending);
    assert.equal(events.filter((event) => event.type === "claude/interactionPending").length, 1);
    await backend.respondToInteraction({ provider: "claude", sessionId, queryGeneration: generation, interactionId: "permission:req-1", requestId: "req-1", toolUseId: "tool-1" }, { decision: "acceptForSession" });
    const response = runtime.commands.at(-1) as Extract<ClaudeWorkerCommand, { type: "interactionResponse" }>;
    assert.equal(response.type, "interactionResponse");
    assert.deepEqual(response.result, {
      behavior: "allow",
      updatedPermissions: pending.payload.suggestions,
      toolUseID: "tool-1",
    });
    await assert.rejects(
      backend.respondToInteraction({ provider: "claude", sessionId, queryGeneration: generation, interactionId: "permission:req-1", requestId: "req-1" }, { decision: "decline" }),
      /不能重复响应/,
    );
    await backend.close();
  });

  it("maps structured answers and rejects stale query responses", async () => {
    const { backend, runtime, sessionId, generation } = await activeBackend();
    runtime.listener?.({
      type: "interactionPending",
      sessionId,
      queryGeneration: generation,
      interactionId: "permission:question",
      kind: "userQuestion",
      payload: {
        requestId: "question",
        toolUseId: "tool-question",
        input: { questions: [{ question: "选择环境", options: [{ label: "本地" }] }] },
      },
    });
    await assert.rejects(
      backend.respondToInteraction({ provider: "claude", sessionId, queryGeneration: generation + 1, interactionId: "permission:question" }, { answers: {} }),
      /Query 已失效/,
    );
    await backend.respondToInteraction(
      { provider: "claude", sessionId, queryGeneration: generation, interactionId: "permission:question", requestId: "question", toolUseId: "tool-question" },
      { answers: { "0": { answers: ["本地"] } } },
    );
    const response = runtime.commands.at(-1) as Extract<ClaudeWorkerCommand, { type: "interactionResponse" }>;
    assert.deepEqual(response.result, {
      behavior: "allow",
      updatedInput: { questions: [{ question: "选择环境", options: [{ label: "本地" }] }], answers: { "选择环境": "本地" } },
      toolUseID: "tool-question",
    });
    await backend.close();
  });

  it("expires pending interactions and fails them when the worker exits", async () => {
    const timed = await activeBackend(5);
    const timedEvents: AgentEventEnvelope[] = [];
    timed.backend.subscribeEvents((event) => timedEvents.push(event));
    timed.runtime.listener?.({ type: "interactionPending", sessionId: timed.sessionId, queryGeneration: timed.generation, interactionId: "permission:timeout", kind: "permission", payload: { requestId: "timeout", toolName: "Read", input: {} } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((timedEvents.find((event) => event.type === "claude/interactionFinished")?.payload as { status?: string }).status, "expired");
    await assert.rejects(
      timed.backend.respondToInteraction({ provider: "claude", sessionId: timed.sessionId, queryGeneration: timed.generation, interactionId: "permission:timeout" }, { decision: "accept" }),
      /不能重复响应/,
    );
    await timed.backend.close();

    const exited = await activeBackend();
    const exitedEvents: AgentEventEnvelope[] = [];
    exited.backend.subscribeEvents((event) => exitedEvents.push(event));
    exited.runtime.listener?.({ type: "interactionPending", sessionId: exited.sessionId, queryGeneration: exited.generation, interactionId: "permission:exit", kind: "permission", payload: { requestId: "exit", toolName: "Write", input: {} } });
    exited.runtime.listener?.({ type: "fatal", message: "worker stopped" });
    assert.equal((exitedEvents.find((event) => event.type === "claude/interactionFinished")?.payload as { status?: string }).status, "failed");
    await assert.rejects(
      exited.backend.respondToInteraction({ provider: "claude", sessionId: exited.sessionId, queryGeneration: exited.generation, interactionId: "permission:exit" }, { decision: "accept" }),
      /Query 已失效/,
    );
    await exited.backend.close();
  });

  it("keeps resume identity until the matching query is ready", async () => {
    const runtime = new FakeRuntime();
    const backend = testBackend(runtime);
    const cwd = path.resolve(process.cwd());
    const nativeSessionId = "44444444-4444-4444-8444-444444444444";
    runtime.known.set(nativeSessionId, cwd);
    await backend.request("resumeSession", { cwd, threadId: nativeSessionId, trustWorkspace: true }, { sessionId: "resume-client", canonicalCwd: cwd });
    await backend.request("startTurn", { input: [{ type: "text", text: "first" }] }, { sessionId: "resume-client", canonicalCwd: cwd });
    const first = runtime.commands.at(-1) as Extract<ClaudeWorkerCommand, { type: "start" }>;
    assert.equal(first.resumeSessionId, nativeSessionId);
    runtime.listener?.({ type: "error", sessionId: "resume-client", queryGeneration: first.queryGeneration, message: "network failed" });
    await backend.request("startTurn", { input: [{ type: "text", text: "retry" }] }, { sessionId: "resume-client", canonicalCwd: cwd });
    const retry = runtime.commands.at(-1) as Extract<ClaudeWorkerCommand, { type: "start" }>;
    assert.equal(retry.resumeSessionId, nativeSessionId);
    runtime.listener?.({ type: "ready", sessionId: "resume-client", queryGeneration: first.queryGeneration, nativeSessionId });
    runtime.listener?.({ type: "ready", sessionId: "resume-client", queryGeneration: retry.queryGeneration, nativeSessionId });
    await backend.close();
  });

  it("registers a fork through resume before its first turn", async () => {
    const runtime = new FakeRuntime();
    const backend = testBackend(runtime);
    const cwd = path.resolve(process.cwd());
    const sourceId = "55555555-5555-4555-8555-555555555555";
    runtime.known.set(sourceId, cwd);
    const fork = await backend.request("forkSession", { cwd, threadId: sourceId }, { canonicalCwd: cwd }) as { thread: { id: string } };
    await backend.request("resumeSession", { cwd, threadId: fork.thread.id, trustWorkspace: true }, { sessionId: "fork-client", canonicalCwd: cwd });
    await backend.request("startTurn", { input: [{ type: "text", text: "continue fork" }] }, { sessionId: "fork-client", canonicalCwd: cwd });
    const start = runtime.commands.at(-1) as Extract<ClaudeWorkerCommand, { type: "start" }>;
    assert.equal(start.resumeSessionId, fork.thread.id);
    await backend.close();
  });

  it("advances search cursors by scanned rows even when matches are sparse", async () => {
    const runtime = new FakeRuntime();
    runtime.searchResult = { data: [], scannedCount: 100, hasMore: true };
    const backend = testBackend(runtime);
    const result = await backend.request("searchSessions", { cwd: process.cwd(), searchTerm: "rare", limit: 25, cursor: "0" }, { canonicalCwd: process.cwd() }) as { nextCursor: string };
    assert.equal(result.nextCursor, "100");
    await backend.close();
  });

  it("probes query capabilities independently", async () => {
    const runtime = new FakeRuntime();
    runtime.failControl.add("mcp");
    runtime.unsupportedControl.add("reloadPlugins");
    const backend = testBackend(runtime);
    const events: AgentEventEnvelope[] = [];
    backend.subscribeEvents((event) => events.push(event));
    const sessionId = "capability-client";
    await backend.request("startSession", { cwd: process.cwd(), trustWorkspace: true }, { sessionId, canonicalCwd: process.cwd() });
    await backend.request("startTurn", { input: [{ type: "text", text: "test" }] }, { sessionId, canonicalCwd: process.cwd() });
    const start = runtime.commands.at(-1) as Extract<ClaudeWorkerCommand, { type: "start" }>;
    runtime.listener?.({ type: "ready", sessionId, queryGeneration: start.queryGeneration });
    await new Promise((resolve) => setImmediate(resolve));
    const updates = events.filter((event) => event.type === "claude/capabilitiesUpdated").map((event) => (event.payload as { capabilities: Record<string, string> }).capabilities);
    assert.ok(updates.some((value) => value.models === "supported"));
    assert.ok(updates.some((value) => value.effort === "supported"));
    assert.ok(updates.some((value) => value.commands === "supported"));
    assert.ok(updates.some((value) => value.skills === "supported"));
    assert.ok(updates.some((value) => value.mcp === "temporarilyUnavailable"));
    assert.ok(updates.some((value) => value.pluginsLoad === "unsupported"));
    assert.ok(updates.some((value) => value.subagents === "supported"));
    assert.ok(updates.some((value) => value.compact === "supported"));
    await backend.close();
  });

  it("uses one credential source for a settings-backed query", async () => {
    const active = await activeBackend();
    const start = active.runtime.commands.find((command): command is Extract<ClaudeWorkerCommand, { type: "start" }> => command.type === "start");
    assert.ok(start);
    assert.equal(start.env, undefined);
    assert.deepEqual(start.settingSources, ["user", "project", "local"]);
    await active.backend.close();
  });
});
