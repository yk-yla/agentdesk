import { parentPort } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  resolveSettings,
  renameSession,
  type Query,
  type ElicitationResult,
  type PermissionResult,
  type SDKSessionInfo,
  type SDKUserMessage,
  type SettingSource,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { redactClaudeMessage } from "./claudeRedaction.js";
import type { ClaudeLifecycleFixtureKind, ClaudeWorkerCommand, ClaudeWorkerEvent } from "./claudeWorkerProtocol.js";
import type { JsonObject } from "../../../shared/protocol.js";
import { validateVerifiedClaudeImage, type VerifiedClaudeImage } from "./claudeImageInput.js";
import { createClaudeSettingsSnapshot, type ClaudeSettingsSnapshot } from "./claudeSettingsSnapshot.js";
import { searchSnippet, sessionSearchText } from "./claudeHistorySearch.js";
import { classifyClaudeGatewayFailure, type ClaudeGatewayFailureKind } from "./claudeGatewayError.js";
import { ClaudeProcessTreeController } from "./claudeProcessTree.js";

if (!parentPort) throw new Error("Claude Worker 缺少父进程通道。");

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private readonly readers: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private ended = false;

  push(textOrBlocks: string | JsonObject[]) {
    if (this.ended) throw new Error("Claude 输入通道已关闭。");
    const blocks: Array<
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
    > = [];
    if (typeof textOrBlocks === "string") {
      blocks.push({ type: "text", text: textOrBlocks });
    } else {
      for (const item of textOrBlocks) {
        if (item.type === "text" && typeof item.text === "string") {
          blocks.push({ type: "text", text: item.text });
          continue;
        }
        if (item.type !== "verifiedImage") continue;
        const image = validateVerifiedClaudeImage(item as VerifiedClaudeImage);
        blocks.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
      }
    }
    if (!blocks.length) throw new Error("Claude 图片输入无法读取。");
    const value: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: blocks as never },
      parent_tool_use_id: null,
    };
    const reader = this.readers.shift();
    if (reader) reader({ value, done: false });
    else this.values.push(value);
  }

  close() {
    this.ended = true;
    while (this.readers.length) this.readers.shift()?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.readers.push(resolve));
      },
    };
  }
}

interface QueryState {
  sessionId: string;
  nativeSessionId: string;
  generation: number;
  query: Query;
  input: InputQueue;
  abortController: AbortController;
  interactions: Map<string, { kind: "permission" | "userQuestion" | "mcpElicitation"; resolve: (result: JsonObject, status?: "resolved" | "cancelled") => void }>;
  settingsSnapshot: ClaudeSettingsSnapshot;
  cleanupTimers?: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>>;
}

const states = new Map<string, QueryState>();
const processTrees = new ClaudeProcessTreeController();
const lifecycleNativeSessions = new Set<string>();
let holdRequestsForTesting = false;

function emit(event: ClaudeWorkerEvent) {
  parentPort!.postMessage(redactClaudeMessage(event));
}

function processEnvironment(secretEnv: Record<string, string>) {
  const allowed = [
    "SystemRoot", "SystemDrive", "ComSpec", "PATHEXT", "PATH", "Path", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ProgramFiles", "ProgramW6432", "CommonProgramFiles", "windir", "LANG",
  ];
  const env: Record<string, string> = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  Object.assign(env, secretEnv, { CLAUDE_AGENT_SDK_CLIENT_APP: "agentdesk/0.1" });
  return env;
}

function interactionPromise(
  command: Extract<ClaudeWorkerCommand, { type: "start" }>,
  state: Pick<QueryState, "interactions">,
  interactionId: string,
  kind: "permission" | "userQuestion" | "mcpElicitation",
  payload: JsonObject,
  signal: AbortSignal,
) {
  return new Promise<JsonObject>((resolve) => {
    const existing = state.interactions.get(interactionId);
    if (existing) {
      resolve({ behavior: "deny", message: "重复的 Claude 交互请求已拒绝。" });
      return;
    }
    const finish = (result: JsonObject, status: "resolved" | "cancelled" = "resolved") => {
      if (!state.interactions.delete(interactionId)) return;
      signal.removeEventListener("abort", abort);
      emit({ type: "interactionFinished", sessionId: command.sessionId, queryGeneration: command.queryGeneration, interactionId, status });
      resolve(result);
    };
    const abort = () => finish(kind === "mcpElicitation"
      ? { action: "cancel" }
      : { behavior: "deny", message: "Claude 交互已取消。", interrupt: false }, "cancelled");
    state.interactions.set(interactionId, { kind, resolve: finish });
    signal.addEventListener("abort", abort, { once: true });
    emit({ type: "interactionPending", sessionId: command.sessionId, queryGeneration: command.queryGeneration, interactionId, kind, payload });
  });
}

function cancelInteractions(state: QueryState, message: string) {
  for (const interaction of [...state.interactions.values()]) {
    interaction.resolve(interaction.kind === "mcpElicitation"
      ? { action: "cancel" }
      : { behavior: "deny", message, interrupt: false }, "cancelled");
  }
}

function spawnLifecycleProcess(command: Extract<ClaudeWorkerCommand, { type: "start" }>) {
  const child = process.platform === "win32"
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "ping -t 127.0.0.1 > nul"], { cwd: command.cwd, windowsHide: true, shell: false, stdio: "ignore" })
    : spawn(process.execPath, ["-e", "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},100000)'],{stdio:'ignore'}); setInterval(()=>{},100000);"], { cwd: command.cwd, windowsHide: true, shell: false, stdio: "ignore" });
  const rootPid = processTrees.track(command.sessionId, command.queryGeneration, child);
  if (rootPid) emit({ type: "processStarted", sessionId: command.sessionId, queryGeneration: command.queryGeneration, rootPid });
}

function lifecycleQuery() {
  return {
    interrupt: async () => undefined,
    return: async () => undefined,
    close: () => undefined,
    supportedModels: async () => [
      { value: "default", displayName: "Default (fixture)", description: "Lifecycle fixture default", supportedEffortLevels: ["low", "medium", "high"] },
      { value: "sonnet", resolvedModel: "claude-sonnet-fixture", displayName: "Sonnet (fixture)", description: "Lifecycle fixture Sonnet", supportedEffortLevels: ["low", "medium", "high"] },
      { value: "haiku", displayName: "Haiku (fixture)", description: "Lifecycle fixture Haiku", supportedEffortLevels: [] },
    ],
    supportedCommands: async () => [],
    supportedAgents: async () => [],
    getContextUsage: async () => ({ totalTokens: 0, maxTokens: 200_000 }),
    mcpServerStatus: async () => [],
    reloadSkills: async () => undefined,
    reloadPlugins: async () => undefined,
    setModel: async () => undefined,
    applyFlagSettings: async () => undefined,
  } as unknown as Query;
}

async function startLifecycleFixture(command: Extract<ClaudeWorkerCommand, { type: "start" }>, scenario: ClaudeLifecycleFixtureKind, input: InputQueue, abortController: AbortController, interactions: QueryState["interactions"]) {
  const state: QueryState = {
    sessionId: command.sessionId,
    nativeSessionId: command.nativeSessionId,
    generation: command.queryGeneration,
    query: lifecycleQuery(),
    input,
    abortController,
    interactions,
    settingsSnapshot: { path: "", dispose: async () => undefined },
    cleanupTimers: [],
  };
  states.set(command.sessionId, state);
  lifecycleNativeSessions.add(command.nativeSessionId);
  spawnLifecycleProcess(command);
  emit({ type: "ready", sessionId: command.sessionId, queryGeneration: command.queryGeneration, nativeSessionId: command.nativeSessionId });
  if (scenario === "longBash" || scenario === "hook" || scenario === "mcp") {
    const toolName = scenario === "hook" ? "Hook" : scenario === "mcp" ? "MCP" : "Bash";
    emit({ type: "message", sessionId: command.sessionId, queryGeneration: command.queryGeneration, payload: { type: "assistant", session_id: command.nativeSessionId, message: { role: "assistant", content: [{ type: "tool_use", id: `fixture-${scenario}`, name: toolName, input: { command: `agentdesk ${scenario} lifecycle fixture` } }] } } });
    return;
  }
  if (scenario === "approval") {
    emit({ type: "message", sessionId: command.sessionId, queryGeneration: command.queryGeneration, payload: { type: "assistant", session_id: command.nativeSessionId, message: { role: "assistant", content: [{ type: "tool_use", id: "fixture-approval", name: "Bash", input: { command: "agentdesk approval fixture" } }] } } });
    void interactionPromise(command, state, "permission:fixture-approval", "permission", { nativeSessionId: command.nativeSessionId, requestId: "fixture-approval", toolUseId: "fixture-approval", toolName: "Bash", input: { command: "agentdesk approval fixture" }, suggestions: [] }, abortController.signal);
    return;
  }
  const interval = setInterval(() => {
    if (states.get(command.sessionId) !== state) return;
    emit({ type: "message", sessionId: command.sessionId, queryGeneration: command.queryGeneration, payload: { type: "stream_event", session_id: command.nativeSessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text: "AgentDesk 流式夹具 " } } } });
  }, 120);
  state.cleanupTimers?.push(interval);
}

async function start(command: Extract<ClaudeWorkerCommand, { type: "start" }>) {
  if (states.has(command.sessionId)) throw new Error("Claude 会话已有活动 Query。");
  const input = new InputQueue();
  input.push(command.input?.length ? command.input : [{ type: "text", text: command.prompt }]);
  const abortController = new AbortController();
  const interactionState = { interactions: new Map<string, { kind: "permission" | "userQuestion" | "mcpElicitation"; resolve: (result: JsonObject, status?: "resolved" | "cancelled") => void }>() };
  const lifecycle = command.gatewayFixture?.lifecycle;
  if (lifecycle) {
    await startLifecycleFixture(command, lifecycle, input, abortController, interactionState.interactions);
    return;
  }
  const secretEnv = command.env;
  const subprocessEnv = secretEnv ? processEnvironment(secretEnv) : undefined;
  if (subprocessEnv && command.gatewayFixture) {
    subprocessEnv.CLAUDE_CODE_MAX_RETRIES = "0";
    subprocessEnv.API_TIMEOUT_MS = String(Math.max(250, command.gatewayFixture.timeoutMs || 2_000));
  }
  if (secretEnv) for (const key of Object.keys(secretEnv)) delete secretEnv[key];
  const resolvedSettings = await resolveSettings({ cwd: command.cwd, settingSources: command.settingSources as SettingSource[] });
  const settingsSnapshot = await createClaudeSettingsSnapshot(resolvedSettings.effective);
  try {
    const claudeQuery = query({
      prompt: input,
      options: {
        abortController,
        cwd: command.cwd,
        settingSources: [],
        settings: settingsSnapshot.path,
      ...(subprocessEnv ? { env: subprocessEnv } : {}),
      includePartialMessages: true,
      permissionMode: "default",
      systemPrompt: { type: "preset", preset: "claude_code" },
      tools: { type: "preset", preset: "claude_code" },
      canUseTool: async (toolName, input, options): Promise<PermissionResult> => {
        const kind = toolName === "AskUserQuestion" ? "userQuestion" : "permission";
        const result = await interactionPromise(command, interactionState, `permission:${options.requestId}`, kind, {
          nativeSessionId: command.nativeSessionId,
          requestId: options.requestId,
          toolUseId: options.toolUseID,
          toolName,
          input,
          suggestions: options.suggestions || [],
          ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
          ...(options.decisionReason ? { decisionReason: options.decisionReason } : {}),
          ...(options.title ? { title: options.title } : {}),
          ...(options.displayName ? { displayName: options.displayName } : {}),
          ...(options.description ? { description: options.description } : {}),
        }, options.signal);
        return result as PermissionResult;
      },
      onElicitation: async (request, options): Promise<ElicitationResult> => {
        const result = await interactionPromise(command, interactionState, `elicitation:${request.elicitationId || randomUUID()}`, "mcpElicitation", {
          nativeSessionId: command.nativeSessionId,
          serverName: request.serverName,
          message: request.message,
          mode: request.mode || "form",
          ...(request.url ? { url: request.url } : {}),
          ...(request.elicitationId ? { elicitationId: request.elicitationId } : {}),
          ...(request.requestedSchema ? { requestedSchema: request.requestedSchema } : {}),
          ...(request.title ? { title: request.title } : {}),
          ...(request.displayName ? { displayName: request.displayName } : {}),
          ...(request.description ? { description: request.description } : {}),
        }, options.signal);
        return result as ElicitationResult;
      },
      ...(command.model ? { model: command.model } : {}),
      ...(command.effort ? { effort: command.effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
      ...(command.executablePath ? { pathToClaudeCodeExecutable: command.executablePath } : {}),
      ...(command.resumeSessionId ? { resume: command.resumeSessionId } : { sessionId: command.nativeSessionId }),
      ...(command.forkSession ? { forkSession: true } : {}),
      spawnClaudeCodeProcess: (options: SpawnOptions) => {
        const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        const rootPid = processTrees.track(command.sessionId, command.queryGeneration, child);
        if (rootPid) emit({ type: "processStarted", sessionId: command.sessionId, queryGeneration: command.queryGeneration, rootPid });
        return child as unknown as SpawnedProcess;
      },
      },
    });
    if (subprocessEnv) for (const key of Object.keys(subprocessEnv)) delete subprocessEnv[key];
    const state: QueryState = { sessionId: command.sessionId, nativeSessionId: command.nativeSessionId, generation: command.queryGeneration, query: claudeQuery, input, abortController, interactions: interactionState.interactions, settingsSnapshot };
    states.set(command.sessionId, state);
    try {
      for await (const message of claudeQuery) {
        if (states.get(command.sessionId) !== state) break;
        if (message.type === "system" && message.subtype === "init") {
          emit({ type: "ready", sessionId: command.sessionId, queryGeneration: command.queryGeneration, nativeSessionId: message.session_id });
        }
        const payload = normalizedSdkMessage(message, command.gatewayFixture?.kind);
        emit({ type: "message", sessionId: command.sessionId, queryGeneration: command.queryGeneration, payload });
        if (payload && typeof payload === "object" && !Array.isArray(payload) && (payload as Record<string, unknown>).gatewayError) break;
      }
    } catch (error) {
      if (states.get(command.sessionId) === state) {
        const failure = classifyClaudeGatewayFailure(error, command.gatewayFixture?.kind);
        emit({ type: "error", sessionId: command.sessionId, queryGeneration: command.queryGeneration, message: failure.message, payload: { kind: failure.kind, retryable: failure.retryable, ...(failure.statusCode ? { statusCode: failure.statusCode } : {}) } });
      }
    } finally {
      cancelInteractions(state, "Claude Query 已结束。");
      if (states.get(command.sessionId) === state) states.delete(command.sessionId);
      await processTrees.close(command.sessionId, command.queryGeneration);
    }
  } finally {
    if (subprocessEnv) for (const key of Object.keys(subprocessEnv)) delete subprocessEnv[key];
    await processTrees.close(command.sessionId, command.queryGeneration);
    await settingsSnapshot.dispose();
  }
}

function normalizedSdkMessage(message: unknown, hint?: ClaudeGatewayFailureKind) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  const payload = message as Record<string, unknown>;
  if (payload.type !== "result" || payload.is_error !== true) return message;
  const source = Array.isArray(payload.errors) ? payload.errors : payload.errors || payload.result || "Claude Query 失败。";
  const failure = classifyClaudeGatewayFailure(source, hint);
  if (failure.kind === "unknown" && !hint) return message;
  return {
    ...payload,
    errors: [failure.message],
    gatewayError: { kind: failure.kind, retryable: failure.retryable, ...(failure.statusCode ? { statusCode: failure.statusCode } : {}) },
  };
}

function sessionSummary(session: SDKSessionInfo) {
  return {
    id: session.sessionId,
    provider: "claude",
    name: session.customTitle || session.summary || session.firstPrompt || "无标题会话",
    cwd: session.cwd || "",
    updatedAt: Math.floor(session.lastModified / 1000),
    source: { kind: "claude" },
  };
}

async function workerRequest(command: Exclude<ClaudeWorkerCommand, { type: "start" | "send" | "interrupt" | "closeSession" | "testHoldRequests" | "testFatal" | "close" }>) {
  if (holdRequestsForTesting) await new Promise<never>(() => undefined);
  if (command.type === "control") {
    const state = states.get(command.sessionId);
    if (!state || state.generation !== command.queryGeneration) throw new Error("Claude Query 已失效。");
    switch (command.action) {
      case "models": return await state.query.supportedModels();
      case "commands": return await state.query.supportedCommands();
      case "agents": return await state.query.supportedAgents();
      case "contextUsage": return await state.query.getContextUsage();
      case "mcp": return await state.query.mcpServerStatus();
      case "reloadSkills": return await state.query.reloadSkills();
      case "reloadPlugins": return await state.query.reloadPlugins();
      case "setModel": await state.query.setModel(command.value || undefined); return { ok: true };
      case "setEffort": await state.query.applyFlagSettings({ effortLevel: command.value as "low" | "medium" | "high" | "xhigh" | "max" }); return { ok: true };
      case "compact": state.input.push("/compact"); return { ok: true };
      default: throw new Error("Claude Query 控制操作不受支持。");
    }
  }
  switch (command.type) {
    case "listSessions": {
      const sessions = await listSessions({ dir: command.cwd, limit: command.limit, offset: command.offset, includeWorktrees: command.includeWorktrees });
      return { data: sessions.map(sessionSummary), hasMore: sessions.length === command.limit };
    }
    case "searchSessions": {
      const sessions = await listSessions({ dir: command.cwd, limit: Math.max(command.limit * 4, 100), offset: command.offset, includeWorktrees: command.includeWorktrees });
      const needle = command.searchTerm.toLocaleLowerCase();
      const results: Array<Record<string, unknown>> = [];
      let scannedCount = 0;
      for (const session of sessions) {
        scannedCount += 1;
        let text = [session.customTitle, session.summary, session.firstPrompt].filter(Boolean).join("\n");
        try {
          text = await sessionSearchText(session, command.cwd, getSessionMessages);
        } catch {
          // 单条历史读取失败不应阻断后续扫描；摘要仍可用于命中。
        }
        if (!text.toLocaleLowerCase().includes(needle)) continue;
        results.push({ thread: sessionSummary(session), snippet: searchSnippet(text, needle) });
        if (results.length >= command.limit) break;
      }
      return { data: results, scannedCount, hasMore: scannedCount < sessions.length || sessions.length === Math.max(command.limit * 4, 100) };
    }
    case "getSessionInfo": {
      return await getSessionInfo(command.nativeSessionId, { dir: command.cwd });
    }
    case "readSession": {
      const [info, messages] = await Promise.all([
        getSessionInfo(command.nativeSessionId, { dir: command.cwd }),
        getSessionMessages(command.nativeSessionId, { dir: command.cwd, limit: command.limit, offset: command.offset }),
      ]);
      return { info: info ? sessionSummary(info) : null, messages };
    }
    case "forkSession": {
      return await forkSession(command.nativeSessionId, { dir: command.cwd, ...(command.title ? { title: command.title } : {}) });
    }
    case "renameSession": {
      await renameSession(command.nativeSessionId, command.title, { dir: command.cwd });
      return { ok: true };
    }
    case "deleteSession": {
      if (lifecycleNativeSessions.delete(command.nativeSessionId)) return { ok: true };
      await deleteSession(command.nativeSessionId, { dir: command.cwd });
      return { ok: true };
    }
    default:
      throw new Error("Claude Worker 请求不受支持。");
  }
}

async function closeSession(sessionId: string, generation?: number) {
  const state = states.get(sessionId);
  if (!state || (generation !== undefined && state.generation !== generation)) return;
  states.delete(sessionId);
  state.cleanupTimers?.forEach((timer) => clearInterval(timer));
  state.cleanupTimers?.forEach((timer) => clearTimeout(timer));
  cancelInteractions(state, "Claude 会话已关闭。");
  state.input.close();
  try { await state.query.return(); } catch { state.query.close(); }
  state.abortController.abort();
  await processTrees.close(sessionId, state.generation);
  await state.settingsSnapshot.dispose();
  emit({ type: "closed", sessionId, queryGeneration: state.generation });
}

parentPort.on("message", (command: ClaudeWorkerCommand) => {
  void (async () => {
    if (command.type === "start") {
      await start(command);
      return;
    }
    if (command.type === "closeSession" && command.requestId) {
      await closeSession(command.sessionId, command.queryGeneration);
      emit({ type: "response", requestId: command.requestId, result: {} });
      return;
    }
    if (command.type === "testHoldRequests") {
      holdRequestsForTesting = true;
      return;
    }
    if (command.type === "testFatal") {
      await fatalShutdown(command.message);
      return;
    }
    if (command.requestId) {
      try {
        emit({ type: "response", requestId: command.requestId, result: await workerRequest(command as Exclude<ClaudeWorkerCommand, { type: "start" | "send" | "interrupt" | "closeSession" | "testHoldRequests" | "testFatal" | "close" }>) });
      } catch (error) {
        emit({ type: "response", requestId: command.requestId, error: error instanceof Error ? error.message : "Claude Worker 请求失败。" });
      }
      return;
    }
    if (command.type === "send") {
      const state = states.get(command.sessionId);
      if (!state || state.generation !== command.queryGeneration) throw new Error("Claude Query 已失效。");
      state.input.push(command.input?.length ? command.input : command.text);
      return;
    }
    if (command.type === "interactionResponse") {
      const state = states.get(command.sessionId);
      if (!state || state.generation !== command.queryGeneration) throw new Error("Claude Query 已失效。");
      const interaction = state.interactions.get(command.interactionId);
      if (!interaction) throw new Error("Claude 交互已处理或不存在。");
      interaction.resolve(command.result);
      return;
    }
    if (command.type === "interrupt") {
      const state = states.get(command.sessionId);
      if (!state || state.generation !== command.queryGeneration) throw new Error("Claude Query 已失效。");
      await state.query.interrupt();
      emit({ type: "interrupted", sessionId: command.sessionId, queryGeneration: command.queryGeneration });
      return;
    }
    if (command.type === "closeSession") {
      await closeSession(command.sessionId, command.queryGeneration);
      return;
    }
    if (command.type === "close") {
      await Promise.all([...states.keys()].map((sessionId) => closeSession(sessionId)));
      parentPort!.close();
    }
  })().catch((error) => emit({
    type: "error",
    sessionId: "sessionId" in command ? command.sessionId : undefined,
    queryGeneration: "queryGeneration" in command ? command.queryGeneration : undefined,
    message: error instanceof Error ? error.message : "Claude Worker 操作失败。",
  }));
});

let fatalClosing = false;
async function fatalShutdown(message: string) {
  if (fatalClosing) return;
  fatalClosing = true;
  emit({ type: "fatal", message });
  await Promise.race([
    Promise.allSettled([...states.keys()].map((sessionId) => closeSession(sessionId))),
    new Promise((resolve) => setTimeout(resolve, 8_000)),
  ]);
  await processTrees.closeAll().catch(() => undefined);
  parentPort!.close();
  process.exit(1);
}

process.on("uncaughtException", (error) => { void fatalShutdown(error.message); });
process.on("unhandledRejection", (error) => { void fatalShutdown(error instanceof Error ? error.message : "Claude Worker 未处理异常。"); });
