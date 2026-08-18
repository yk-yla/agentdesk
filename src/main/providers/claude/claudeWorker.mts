import { parentPort } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
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
import type { ClaudePluginOperation } from "./claudeWorkerProtocol.js";
import type { JsonObject } from "../../../shared/protocol.js";
import { validateVerifiedClaudeImage, type VerifiedClaudeImage } from "./claudeImageInput.js";
import { createClaudeSettingsSnapshot, type ClaudeSettingsSnapshot } from "./claudeSettingsSnapshot.js";
import { searchSnippet, sessionSearchText } from "./claudeHistorySearch.js";
import { classifyClaudeGatewayFailure, type ClaudeGatewayFailureKind } from "./claudeGatewayError.js";
import { ClaudeProcessTreeController, terminateClaudeProcessTree } from "./claudeProcessTree.js";
import { verifyWorkerLocalMarketplacePath } from "./claudeMarketplacePolicy.js";
import { automaticClaudeToolPermission, settingsWithoutClaudePermissionRules } from "./claudePermissionPolicy.js";

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
      uuid: randomUUID(),
      origin: { kind: "human" },
      timestamp: new Date().toISOString(),
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
const nodeRequire = createRequire(import.meta.url);
const lifecycleNativeSessions = new Set<string>();
let holdRequestsForTesting = false;
const MAX_PLUGIN_OUTPUT_BYTES = 2 * 1024 * 1024;
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9._:-]{1,160}(?:@[A-Za-z0-9._:-]{1,160})?$/;
const MARKETPLACE_NAME_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

function safeCliText(value: unknown, label: string, max = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Claude ${label} 无效。`);
  return value.trim();
}

function safePluginName(value: unknown) {
  const name = safeCliText(value, "插件名称");
  if (!PLUGIN_NAME_PATTERN.test(name)) throw new Error("Claude 插件名称格式无效。");
  return name;
}

function safeMarketplaceName(value: unknown) {
  const name = safeCliText(value, "插件市场名称");
  if (!MARKETPLACE_NAME_PATTERN.test(name)) throw new Error("Claude 插件市场名称格式无效。");
  return name;
}

function safeMarketplaceSource(value: unknown, cwd: string, authorizedLocalMarketplacePath?: string) {
  const source = safeCliText(value, "插件市场来源", 2_048);
  if (/^(?:https?|git):\/\//i.test(source) || /^git@[^:]+:[^\s]+$/i.test(source) || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[A-Za-z0-9._/-]+)?$/.test(source)) return source;
  if (/^[.\\/]|^[A-Za-z]:[\\/]/.test(source)) {
    return verifyWorkerLocalMarketplacePath(source, cwd, authorizedLocalMarketplacePath);
  }
  throw new Error("Claude 插件市场来源必须是 HTTP(S)、Git、GitHub 仓库或受控本地路径。");
}

function pluginExecutable(command: Extract<ClaudeWorkerCommand, { type: "plugin" }>) {
  const configured = command.executablePath?.trim();
  if (configured) return configured;
  try { return nodeRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude.exe`); } catch { /* optional SDK binary absent */ }
  return process.platform === "win32" ? "claude.exe" : "claude";
}

function pluginConfigDir(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Claude 插件隔离配置目录无效。");
  }
  return path.resolve(value);
}

function runClaudePluginCli(command: Extract<ClaudeWorkerCommand, { type: "plugin" }>, args: string[], timeoutMs = 120_000) {
  return new Promise<string>((resolve, reject) => {
    const configDir = pluginConfigDir(command.configDir);
    const child = spawn(pluginExecutable(command), args, {
      cwd: command.cwd,
      env: processEnvironment(command.env || {}, configDir),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void terminateClaudeProcessTree(child).catch(() => undefined).finally(() => reject(error));
    };
    const timer = setTimeout(() => fail(new Error("Claude 插件命令超时。")), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_PLUGIN_OUTPUT_BYTES) return fail(new Error("Claude 插件命令输出过大。"));
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
    child.once("error", (error) => fail(error instanceof Error ? error : new Error("Claude 插件命令启动失败。")));
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `Claude 插件命令失败（${code ?? "unknown"}）。`));
    });
  });
}

function jsonOutput(value: string, label: string) {
  try {
    const parsed = JSON.parse(value || "null");
    if (!parsed || typeof parsed !== "object") throw new Error();
    return parsed;
  } catch {
    throw new Error(`Claude ${label} 返回了无效 JSON。`);
  }
}

function pluginSummary(value: unknown, marketplace = "") {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rawName = typeof record.name === "string" ? record.name : typeof record.id === "string" ? record.id : "";
  const separator = rawName.lastIndexOf("@");
  const inferredMarketplace = separator > 0 ? rawName.slice(separator + 1) : "";
  const market = typeof record.marketplaceName === "string" ? record.marketplaceName : typeof record.marketplace === "string" ? record.marketplace : inferredMarketplace || marketplace;
  const name = separator > 0 && !record.marketplaceName && !record.marketplace ? rawName.slice(0, separator) : rawName;
  return {
    id: typeof record.id === "string" ? record.id : `${name}${market ? `@${market}` : ""}`,
    name,
    marketplace: market,
    installed: record.installed === true,
    enabled: record.enabled !== false,
    version: typeof record.version === "string" ? record.version : "",
    localVersion: typeof record.localVersion === "string" ? record.localVersion : "",
    interface: { shortDescription: typeof record.description === "string" ? record.description : typeof record.shortDescription === "string" ? record.shortDescription : "Claude Code 插件", longDescription: typeof record.description === "string" ? record.description : "" },
  };
}

function normalizePluginList(raw: Record<string, unknown>, marketplaceValue: unknown) {
  const marketplaces = new Map<string, { name: string; path: string; plugins: Map<string, Record<string, unknown>> }>();
  const marketplaceItems = Array.isArray(marketplaceValue)
    ? marketplaceValue
    : marketplaceValue && typeof marketplaceValue === "object" && Array.isArray((marketplaceValue as Record<string, unknown>).marketplaces)
      ? (marketplaceValue as Record<string, unknown>).marketplaces as unknown[]
      : [];
  marketplaceItems.forEach((value) => {
    const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const name = typeof record.name === "string" ? record.name : "";
    if (name) marketplaces.set(name, { name, path: typeof record.path === "string" ? record.path : "", plugins: new Map() });
  });
  const add = (value: unknown, installed: boolean) => {
    const summary = pluginSummary(value);
    if (!summary.name) return;
    const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const market = typeof record.marketplaceName === "string" ? record.marketplaceName : typeof record.marketplace === "string" ? record.marketplace : typeof summary.marketplace === "string" ? summary.marketplace : "Claude Code";
    const entry = marketplaces.get(market) || { name: market, path: "", plugins: new Map<string, Record<string, unknown>>() };
    const key = summary.id || summary.name;
    const previous = entry.plugins.get(key);
    entry.plugins.set(key, { ...previous, ...summary, installed: installed || summary.installed || previous?.installed === true });
    marketplaces.set(market, entry);
  };
  (Array.isArray(raw.installed) ? raw.installed : []).forEach((item) => add(item, true));
  (Array.isArray(raw.available) ? raw.available : []).forEach((item) => add(item, false));
  return { marketplaces: [...marketplaces.values()].map((entry) => ({ ...entry, plugins: [...entry.plugins.values()] })) };
}

async function pluginRequest(command: Extract<ClaudeWorkerCommand, { type: "plugin" }>) {
  switch (command.operation) {
    case "list": {
      const [plugins, marketplaces] = await Promise.all([
        runClaudePluginCli(command, ["plugin", "list", "--json", "--available"]),
        runClaudePluginCli(command, ["plugin", "marketplace", "list", "--json"]),
      ]);
      const pluginValue = jsonOutput(plugins, "插件列表");
      if (!pluginValue || typeof pluginValue !== "object" || Array.isArray(pluginValue)) throw new Error("Claude 插件列表返回了无效 JSON。");
      return normalizePluginList(pluginValue as Record<string, unknown>, jsonOutput(marketplaces, "插件市场列表"));
    }
    case "details": {
      const plugin = safePluginName(command.plugin);
      return { plugin: { name: plugin, description: await runClaudePluginCli(command, ["plugin", "details", plugin]) } };
    }
    case "install": {
      const plugin = safePluginName(command.plugin);
      await runClaudePluginCli(command, ["plugin", "install", plugin, "--scope", "user"]);
      return { ok: true };
    }
    case "uninstall": {
      const plugin = safePluginName(command.plugin);
      await runClaudePluginCli(command, ["plugin", "uninstall", plugin, "--scope", "user"]);
      return { ok: true };
    }
    case "update": {
      const plugin = safePluginName(command.plugin);
      await runClaudePluginCli(command, ["plugin", "update", plugin, "--scope", "user"]);
      return { ok: true };
    }
    case "marketplaceList": {
      const raw = jsonOutput(await runClaudePluginCli(command, ["plugin", "marketplace", "list", "--json"]), "插件市场列表");
      const entries = Array.isArray(raw) ? raw : Array.isArray((raw as Record<string, unknown>).marketplaces) ? (raw as Record<string, unknown>).marketplaces as unknown[] : [];
      return { marketplaces: entries.map((item) => { const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {}; return { name: typeof record.name === "string" ? record.name : "未命名市场", path: typeof record.path === "string" ? record.path : "", plugins: [] }; }) };
    }
    case "marketplaceAdd": {
      const source = safeMarketplaceSource(command.source, command.cwd, command.authorizedLocalMarketplacePath);
      await runClaudePluginCli(command, ["plugin", "marketplace", "add", "--scope", "user", source]);
      return { ok: true };
    }
    case "marketplaceUpdate": {
      const args = ["plugin", "marketplace", "update"];
      if (command.marketplace) args.push(safeMarketplaceName(command.marketplace));
      await runClaudePluginCli(command, args);
      return { ok: true };
    }
    case "marketplaceRemove": {
      const marketplace = safeMarketplaceName(command.marketplace);
      await runClaudePluginCli(command, ["plugin", "marketplace", "remove", marketplace]);
      return { ok: true };
    }
  }
}

function emit(event: ClaudeWorkerEvent) {
  parentPort!.postMessage(redactClaudeMessage(event));
}

function processEnvironment(secretEnv: Record<string, string>, configDir?: string) {
  const allowed = [
    "SystemRoot", "SystemDrive", "ComSpec", "PATHEXT", "PATH", "Path", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ProgramFiles", "ProgramW6432", "CommonProgramFiles", "windir", "LANG",
  ];
  const env: Record<string, string> = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  Object.assign(env, secretEnv, configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}, { CLAUDE_AGENT_SDK_CLIENT_APP: "agentdesk/0.1" });
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
    supportedCommands: async () => [{ name: "compact", description: "压缩当前上下文" }],
    supportedAgents: async () => [],
    getContextUsage: async () => ({ totalTokens: 3_200, maxTokens: 200_000 }),
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
  if (scenario === "incompleteTool") {
    emit({
      type: "message",
      sessionId: command.sessionId,
      queryGeneration: command.queryGeneration,
      payload: {
        type: "stream_event",
        uuid: "fixture-incomplete-tool-message",
        session_id: command.nativeSessionId,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "fixture-incomplete-write", name: "Write", input: {} },
        },
      },
    });
    const timer = setTimeout(() => emit({
      type: "message",
      sessionId: command.sessionId,
      queryGeneration: command.queryGeneration,
      payload: {
        type: "result",
        subtype: "success",
        is_error: false,
        stop_reason: "tool_use",
        session_id: command.nativeSessionId,
        result: "Now writing the consolidated report.",
      },
    }), 100);
    state.cleanupTimers?.push(timer);
    return;
  }
  if (scenario === "longBash" || scenario === "hook" || scenario === "mcp") {
    const toolName = scenario === "hook" ? "Hook" : scenario === "mcp" ? "MCP" : "Bash";
    emit({ type: "message", sessionId: command.sessionId, queryGeneration: command.queryGeneration, payload: { type: "assistant", session_id: command.nativeSessionId, message: { role: "assistant", content: [{ type: "tool_use", id: `fixture-${scenario}`, name: toolName, input: { command: `agentdesk ${scenario} lifecycle fixture` } }] } } });
    return;
  }
  if (scenario === "userQuestion") {
    const input = { questions: [{ header: "执行方式", question: "Claude 应该怎样继续？", options: [{ label: "继续执行", description: "按当前计划继续" }, { label: "停止", description: "停止当前任务" }], multiSelect: false }] };
    emit({ type: "message", sessionId: command.sessionId, queryGeneration: command.queryGeneration, payload: { type: "assistant", session_id: command.nativeSessionId, message: { role: "assistant", content: [{ type: "tool_use", id: "fixture-user-question", name: "AskUserQuestion", input }] } } });
    void interactionPromise(command, state, "permission:fixture-user-question", "userQuestion", { nativeSessionId: command.nativeSessionId, requestId: "fixture-user-question", toolUseId: "fixture-user-question", toolName: "AskUserQuestion", input, suggestions: [] }, abortController.signal);
    return;
  }
  let streamStep = 0;
  const firstMessageId = "msg_fixture_stream_first";
  const secondMessageId = "msg_fixture_stream_second";
  const interval = setInterval(() => {
    if (states.get(command.sessionId) !== state) return;
    streamStep += 1;
    if (streamStep === 1) {
      emit({ type: "message", sessionId: command.sessionId, queryGeneration: command.queryGeneration, payload: { type: "stream_event", uuid: "fixture-stream-first-start", session_id: command.nativeSessionId, event: { type: "message_start", message: { id: firstMessageId, role: "assistant", content: [] } } } });
      emit({ type: "message", sessionId: command.sessionId, queryGeneration: command.queryGeneration, payload: { type: "stream_event", uuid: "fixture-stream-first-delta-1", session_id: command.nativeSessionId, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "AgentDesk 流式" } } } });
      emit({ type: "message", sessionId: command.sessionId, queryGeneration: command.queryGeneration, payload: { type: "stream_event", uuid: "fixture-stream-first-delta-2", session_id: command.nativeSessionId, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "夹具 第一条" } } } });
    } else if (streamStep === 2) {
      emit({ type: "message", sessionId: command.sessionId, queryGeneration: command.queryGeneration, payload: { type: "assistant", uuid: "fixture-stream-first-final", session_id: command.nativeSessionId, message: { id: firstMessageId, role: "assistant", content: [{ type: "text", text: "AgentDesk 流式夹具 第一条" }] } } });
    } else if (streamStep === 3) {
      emit({ type: "message", sessionId: command.sessionId, queryGeneration: command.queryGeneration, payload: { type: "stream_event", uuid: "fixture-stream-second-start", session_id: command.nativeSessionId, event: { type: "message_start", message: { id: secondMessageId, role: "assistant", content: [] } } } });
      emit({ type: "message", sessionId: command.sessionId, queryGeneration: command.queryGeneration, payload: { type: "stream_event", uuid: "fixture-stream-second-delta", session_id: command.nativeSessionId, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "AgentDesk 流式夹具 第二条" } } } });
    } else {
      clearInterval(interval);
      emit({ type: "message", sessionId: command.sessionId, queryGeneration: command.queryGeneration, payload: { type: "assistant", uuid: "fixture-stream-second-final", session_id: command.nativeSessionId, message: { id: secondMessageId, role: "assistant", content: [{ type: "text", text: `AgentDesk 流式夹具 第二条 ${"长".repeat(8_300)} CLAUDE_LONG_TEXT_END` }] } } });
    }
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
  const settingsSnapshot = await createClaudeSettingsSnapshot(settingsWithoutClaudePermissionRules(resolvedSettings.effective));
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
        const automatic = automaticClaudeToolPermission(toolName, input);
        if (automatic) return automatic;
        const result = await interactionPromise(command, interactionState, `permission:${options.requestId}`, "userQuestion", {
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

async function compactSession(command: Extract<ClaudeWorkerCommand, { type: "compactSession" }>) {
  if (command.gatewayFixture?.lifecycle === "compact") {
    emit({
      type: "message",
      sessionId: command.sessionId,
      queryGeneration: command.queryGeneration,
      payload: {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 3_200, post_tokens: 900 },
        uuid: randomUUID(),
        session_id: command.nativeSessionId,
      },
    });
    emit({
      type: "message",
      sessionId: command.sessionId,
      queryGeneration: command.queryGeneration,
      payload: { type: "result", subtype: "success", is_error: false, session_id: command.nativeSessionId, result: "" },
    });
    return { ok: true };
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
  const abortController = new AbortController();
  let compactBoundary = false;
  let resultSeen = false;
  try {
    const compactQuery = query({
      prompt: "/compact",
      options: {
        abortController,
        cwd: command.cwd,
        settingSources: [],
        settings: settingsSnapshot.path,
        ...(subprocessEnv ? { env: subprocessEnv } : {}),
        permissionMode: "default",
        systemPrompt: { type: "preset", preset: "claude_code" },
        tools: { type: "preset", preset: "claude_code" },
        canUseTool: async (): Promise<PermissionResult> => ({ behavior: "deny", message: "Claude 压缩期间不允许执行工具。", interrupt: false }),
        ...(command.model ? { model: command.model } : {}),
        ...(command.effort ? { effort: command.effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
        ...(command.executablePath ? { pathToClaudeCodeExecutable: command.executablePath } : {}),
        resume: command.nativeSessionId,
        spawnClaudeCodeProcess: (options: SpawnOptions) => {
          const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
          const rootPid = processTrees.track(command.sessionId, command.queryGeneration, child);
          if (rootPid) emit({ type: "processStarted", sessionId: command.sessionId, queryGeneration: command.queryGeneration, rootPid });
          return child as unknown as SpawnedProcess;
        },
      },
    });
    try {
      for await (const message of compactQuery) {
        const payload = normalizedSdkMessage(message, command.gatewayFixture?.kind);
        emit({ type: "message", sessionId: command.sessionId, queryGeneration: command.queryGeneration, payload });
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          const record = payload as Record<string, unknown>;
          if (record.type === "system" && record.subtype === "compact_boundary") compactBoundary = true;
          if (record.type === "result") {
            resultSeen = true;
            if (record.is_error === true) {
              const errors = Array.isArray(record.errors) ? record.errors.map(String).join("\n") : "Claude 压缩失败。";
              throw new Error(errors);
            }
          }
        }
      }
    } finally {
      try { await compactQuery.return(); } catch { compactQuery.close(); }
    }
    if (!resultSeen) throw new Error("Claude 压缩未返回结果。");
    return { ok: true, compacted: compactBoundary };
  } finally {
    abortController.abort();
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

function modelFromSessionMessages(messages: unknown) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const message = record.message;
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const model = (message as Record<string, unknown>).model;
      if (typeof model === "string" && model.trim()) return model.trim();
    }
    const model = record.model;
    if (typeof model === "string" && model.trim()) return model.trim();
  }
  return "";
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
      default: throw new Error("Claude Query 控制操作不受支持。");
    }
  }
  switch (command.type) {
    case "plugin": {
      return await pluginRequest(command);
    }
    case "compactSession": {
      return await compactSession(command);
    }
    case "listSessions": {
      const sessions = await listSessions({ ...(command.cwd ? { dir: command.cwd } : {}), limit: command.limit, offset: command.offset, includeWorktrees: command.includeWorktrees });
      return { data: sessions.map(sessionSummary), hasMore: sessions.length === command.limit };
    }
    case "searchSessions": {
      const sessions = await listSessions({ ...(command.cwd ? { dir: command.cwd } : {}), limit: Math.max(command.limit * 4, 100), offset: command.offset, includeWorktrees: command.includeWorktrees });
      const needle = command.searchTerm.toLocaleLowerCase();
      const results: Array<Record<string, unknown>> = [];
      let scannedCount = 0;
      for (const session of sessions) {
        scannedCount += 1;
        let text = [session.customTitle, session.summary, session.firstPrompt].filter(Boolean).join("\n");
        try {
          text = await sessionSearchText(session, session.cwd || command.cwd, getSessionMessages);
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
        getSessionMessages(command.nativeSessionId, { dir: command.cwd, limit: command.limit, offset: command.offset, includeSystemMessages: true }),
      ]);
      const model = modelFromSessionMessages(messages);
      return { info: info ? sessionSummary(info) : null, messages, ...(model ? { model } : {}) };
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
  if (!state) {
    if (generation !== undefined) await processTrees.close(sessionId, generation);
    return;
  }
  if (generation !== undefined && state.generation !== generation) return;
  states.delete(sessionId);
  state.cleanupTimers?.forEach((timer) => clearInterval(timer));
  state.cleanupTimers?.forEach((timer) => clearTimeout(timer));
  cancelInteractions(state, "Claude 会话已关闭。");
  state.input.close();
  state.abortController.abort();
  const queryCleanup = Promise.resolve().then(async () => {
    try { await state.query.return(); } catch { state.query.close(); }
  });
  const boundedQueryCleanup = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Claude Query 清理超时。")), 12_000);
    queryCleanup.then(
      () => { clearTimeout(timer); resolve(); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
  const results = await Promise.allSettled([
    boundedQueryCleanup,
    processTrees.close(sessionId, state.generation),
    state.settingsSnapshot.dispose(),
  ]);
  const failures = results.flatMap((result) => result.status === "rejected"
    ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
    : []);
  if (failures.length) throw new Error(failures.join("；"));
  emit({ type: "closed", sessionId, queryGeneration: state.generation });
}

async function cleanupWorker() {
  const results = await Promise.allSettled([...states.keys()].map((sessionId) => closeSession(sessionId)));
  const failures = results.flatMap((result) => result.status === "rejected"
    ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
    : []);
  try {
    await processTrees.closeAll();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  return failures.length ? failures.join("；") : undefined;
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
      const error = await cleanupWorker();
      emit({ type: "cleanupComplete", ...(error ? { error } : {}) });
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
  const error = await cleanupWorker();
  emit({ type: "cleanupComplete", ...(error ? { error } : {}) });
  parentPort!.close();
  process.exit(1);
}

process.on("uncaughtException", (error) => { void fatalShutdown(error.message); });
process.on("unhandledRejection", (error) => { void fatalShutdown(error instanceof Error ? error.message : "Claude Worker 未处理异常。"); });
