import type { AgentOperation, AgentProvider, AgentRequestContext, InteractionRef } from "../../shared/agentProtocol";
import type { DesktopPreferences, JsonObject } from "../../shared/protocol";
import type { AppLogger } from "../logger";
import { logErrorDetails } from "../logger";
import { randomUUID } from "node:crypto";
import { normalizeFavoriteSessionSummaries } from "../../shared/favoriteSessions";
import { normalizeBaseFontSize, normalizeClaudeModelCache, normalizeCompactionCounts, normalizeCodexCompactionCounts, normalizeDismissedSessionNotices, normalizeExternalTerminal, normalizeLastModels, normalizeLastReasoningEfforts, normalizeModelContextWindows, normalizeRecentCommandUsage, normalizeSidebarWidth, normalizeTheme } from "../preferencesStore";

const AGENT_PROVIDERS = new Set<AgentProvider>(["codex", "claude"]);
const AGENT_OPERATIONS = new Set<AgentOperation>([
  "listModels", "listSkills", "listSessions", "searchSessions", "readSession", "startSession", "resumeSession", "forkSession",
  "renameSession", "deleteSession", "updateSessionMetadata", "updateSessionSettings", "startTurn", "startReview", "steerTurn",
  "generateSessionTitle",
  "interruptTurn", "compactSession", "readRateLimits", "listMcpServers", "getGoal", "setGoal", "clearGoal",
  "getCapabilities", "closeSession",
]);
const MAX_CLIENT_LOG_DETAILS_BYTES = 64 * 1024;

interface IpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void;
}

interface PreferenceService {
  read(): DesktopPreferences;
  write(patch: Partial<DesktopPreferences>): DesktopPreferences | Promise<DesktopPreferences>;
}

interface DesktopIpcServices {
  logger?: AppLogger;
  workspace: {
    current(): string;
    launchProvider(): AgentProvider | null;
    choose(defaultPath?: string): Promise<string | null>;
    register(cwd: unknown): Promise<string | null>;
  };
  preferences: PreferenceService;
  workspaceSnapshot: {
    complete(requestId: string, workspaceState: JsonObject): unknown;
  };
  codexDefaults(): unknown;
  files: {
    saveClipboardImage(input: unknown): unknown;
    readClipboardText(): unknown;
    writeClipboardText(text: unknown): unknown;
    copyImage(dataUrl: unknown): unknown;
    authorizePastedFile(filePath: unknown): unknown;
    saveTextFile(input: unknown): unknown;
    exportDiagnostics(): unknown;
    createHandoff(input: unknown): unknown;
    readLocalImage(filePath: unknown): unknown;
    openLocalPath(filePath: unknown): unknown;
    openExternal(url: unknown): unknown;
    openExternalTerminal(input: unknown): unknown;
  };
  showNotification(input: unknown): unknown;
  window: {
    state(): unknown;
    minimize(): unknown;
    toggleMaximize(): unknown;
  };
  desktopUpdate: {
    status(): unknown;
    check(): unknown;
    download(): unknown;
    install(): unknown;
  };
  codexUpdate: {
    status(): unknown;
    check(): unknown;
    install(): unknown;
  };
  claude: {
    status(): unknown;
    checkUpdate(): unknown;
    installUpdate(allowUnverified: boolean): unknown;
  };
  agent: {
    request(request: ValidatedAgentRequest): unknown;
    respond(response: { ref: InteractionRef; result: JsonObject }): unknown;
  };
  development?: {
    holdClaudeWorkerRequests(): unknown;
    injectClaudeWorkerFatal(): unknown;
    setClaudeGatewayFixture(kind: unknown): unknown;
    setClaudeLifecycleFixture(kind: unknown): unknown;
    setDesktopUpdateFixture(): unknown;
    shutdownDryRun(): unknown;
    quitApp(): unknown;
    setClaudeSignatureFixture(kind: unknown): unknown;
  };
}

export interface ValidatedAgentRequest {
  provider: AgentProvider;
  operation: AgentOperation;
  params: JsonObject;
  context: AgentRequestContext;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function sanitizePreferencesPatch(value: unknown): Partial<DesktopPreferences> {
  const patch = objectRecord(value);
  if (!patch) return {};
  return {
    ...(typeof patch.theme === "string" && normalizeTheme(patch.theme) === patch.theme ? { theme: normalizeTheme(patch.theme) } : {}),
    ...(typeof patch.lastWorkspace === "string" ? { lastWorkspace: patch.lastWorkspace } : {}),
    ...(Array.isArray(patch.favoriteWorkspaces) ? { favoriteWorkspaces: patch.favoriteWorkspaces.filter((item): item is string => typeof item === "string").slice(0, 32) } : {}),
    ...(typeof patch.sidebarWidth === "number" && Number.isFinite(patch.sidebarWidth) ? { sidebarWidth: normalizeSidebarWidth(patch.sidebarWidth) } : {}),
    ...(typeof patch.baseFontSize === "number" && Number.isFinite(patch.baseFontSize) ? { baseFontSize: normalizeBaseFontSize(patch.baseFontSize) } : {}),
    ...(objectRecord(patch.sessionAliases)
      ? { sessionAliases: Object.fromEntries(Object.entries(patch.sessionAliases as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0).slice(0, 2_000)) }
      : {}),
    ...(Array.isArray(patch.pinnedSessions) ? { pinnedSessions: patch.pinnedSessions.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 2_000) } : {}),
    ...(Array.isArray(patch.favoriteSessions) ? { favoriteSessions: patch.favoriteSessions.filter((item): item is string => typeof item === "string").slice(0, 2_000) } : {}),
    ...(objectRecord(patch.favoriteSessionSummaries) ? { favoriteSessionSummaries: normalizeFavoriteSessionSummaries(patch.favoriteSessionSummaries) } : {}),
    ...(objectRecord(patch.modelContextWindows) ? { modelContextWindows: normalizeModelContextWindows(patch.modelContextWindows) } : {}),
    ...(objectRecord(patch.lastModels) ? { lastModels: normalizeLastModels(patch.lastModels) } : {}),
    ...(objectRecord(patch.claudeModelCache) ? (() => {
      const cache = normalizeClaudeModelCache(patch.claudeModelCache);
      return cache ? { claudeModelCache: cache } : {};
    })() : {}),
    ...(objectRecord(patch.lastReasoningEfforts) ? { lastReasoningEfforts: normalizeLastReasoningEfforts(patch.lastReasoningEfforts) } : {}),
    ...(objectRecord(patch.recentCommandUsage) ? { recentCommandUsage: normalizeRecentCommandUsage(patch.recentCommandUsage) } : {}),
    ...(objectRecord(patch.compactionCounts) ? { compactionCounts: normalizeCompactionCounts(patch.compactionCounts) } : {}),
    ...(objectRecord(patch.codexCompactionCounts) ? { codexCompactionCounts: normalizeCodexCompactionCounts(patch.codexCompactionCounts) } : {}),
    ...(objectRecord(patch.dismissedSessionNotices) ? { dismissedSessionNotices: normalizeDismissedSessionNotices(patch.dismissedSessionNotices) } : {}),
    ...(objectRecord(patch.workspaceState) ? { workspaceState: patch.workspaceState as JsonObject } : {}),
    ...(objectRecord(patch.externalTerminal) ? { externalTerminal: normalizeExternalTerminal(patch.externalTerminal) } : {}),
  };
}

export function validateAgentRequest(value: unknown): ValidatedAgentRequest {
  const request = objectRecord(value);
  if (!request || !AGENT_PROVIDERS.has(request.provider as AgentProvider) || !AGENT_OPERATIONS.has(request.operation as AgentOperation)) {
    throw new Error("Agent 请求无效或未获授权。");
  }
  const params = request.params === undefined ? {} : objectRecord(request.params);
  if (!params) throw new Error("Agent 请求参数无效。");
  const rawContext = objectRecord(request.context) || {};
  const context: AgentRequestContext = {
    ...(typeof rawContext.requestId === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(rawContext.requestId) ? { requestId: rawContext.requestId } : {}),
    ...(typeof rawContext.sessionId === "string" && rawContext.sessionId.length <= 160 ? { sessionId: rawContext.sessionId } : {}),
    ...(typeof rawContext.canonicalCwd === "string" && rawContext.canonicalCwd.length <= 32_768 ? { canonicalCwd: rawContext.canonicalCwd } : {}),
    ...(typeof rawContext.nativeSessionId === "string" && rawContext.nativeSessionId.length <= 256 ? { nativeSessionId: rawContext.nativeSessionId } : {}),
    ...(Number.isSafeInteger(rawContext.queryGeneration) ? { queryGeneration: rawContext.queryGeneration as number } : {}),
  };
  return { provider: request.provider as AgentProvider, operation: request.operation as AgentOperation, params, context };
}

export function validateAgentResponse(value: unknown) {
  const response = objectRecord(value);
  const ref = objectRecord(response?.ref);
  const result = objectRecord(response?.result);
  if (!response || !ref || !AGENT_PROVIDERS.has(ref.provider as AgentProvider) || !result) {
    throw new Error("Agent 交互响应无效。");
  }
  return { ref: response.ref as InteractionRef, result };
}

export function validateClientLog(value: unknown) {
  const entry = objectRecord(value);
  const level = entry?.level;
  const event = entry?.event;
  const details = entry?.details;
  let detailsBytes = 0;
  try {
    detailsBytes = details && typeof details === "object" && !Array.isArray(details)
      ? Buffer.byteLength(JSON.stringify(details), "utf8")
      : 0;
  } catch {
    throw new Error("客户端日志详情无效。");
  }
  if (!entry || typeof event !== "string" || !event.trim() || event.length > 160 || detailsBytes > MAX_CLIENT_LOG_DETAILS_BYTES || (level !== undefined && level !== "debug" && level !== "info" && level !== "warn" && level !== "error")) {
    throw new Error("客户端日志无效。");
  }
  return {
    level: (level || "info") as "debug" | "info" | "warn" | "error",
    event: event.trim(),
    details: details && typeof details === "object" && !Array.isArray(details) ? details as JsonObject : {},
  };
}

export function validateWorkspaceSnapshotSubmission(value: unknown) {
  const submission = objectRecord(value);
  const workspaceState = objectRecord(submission?.workspaceState);
  if (!submission || typeof submission.requestId !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(submission.requestId) || !workspaceState) {
    throw new Error("工作区快照响应无效。");
  }
  return { requestId: submission.requestId, workspaceState: workspaceState as JsonObject };
}

export function registerDesktopIpc(ipc: IpcRegistrar, services: DesktopIpcServices) {
  const rawHandle = ipc.handle.bind(ipc);
  ipc = {
    handle(channel, listener) {
      rawHandle(channel, async (event, ...args) => {
        const logRequest = channel !== "agentdesk:write-log" && channel !== "agent:request" && channel !== "agent:respond";
        const suppliedRequestId = channel === "agent:request" && args[0] && typeof args[0] === "object" && "context" in args[0] && args[0].context && typeof args[0].context === "object" && "requestId" in args[0].context && typeof args[0].context.requestId === "string" ? args[0].context.requestId : undefined;
        const requestId = suppliedRequestId || randomUUID();
        const startedAt = Date.now();
        try {
          const result = await listener(event, ...args);
          if (logRequest && Date.now() - startedAt >= 1_000) services.logger?.log("info", "ipc.request.slow", { requestId, channel, durationMs: Date.now() - startedAt });
          return result;
        } catch (error) {
          if (logRequest) services.logger?.log("error", "ipc.request.failed", { requestId, channel, durationMs: Date.now() - startedAt, error: logErrorDetails(error) });
          throw error;
        }
      });
    },
  };
  ipc.handle("agentdesk:write-log", (_event, entry: unknown) => {
    const value = validateClientLog(entry);
    services.logger?.log(value.level, value.event, value.details);
  });
  ipc.handle("agentdesk:get-workspace", () => services.workspace.current());
  ipc.handle("agentdesk:get-launch-provider", () => services.workspace.launchProvider());
  ipc.handle("agentdesk:choose-workspace", (_event, defaultPath: unknown) => services.workspace.choose(typeof defaultPath === "string" ? defaultPath : undefined));
  ipc.handle("agentdesk:register-workspace", (_event, cwd: unknown) => services.workspace.register(cwd));
  ipc.handle("agentdesk:get-preferences", () => services.preferences.read());
  ipc.handle("agentdesk:save-preferences", (_event, patch: unknown) => services.preferences.write(sanitizePreferencesPatch(patch)));
  ipc.handle("agentdesk:workspace-snapshot-save", (_event, value: unknown) => {
    const submission = validateWorkspaceSnapshotSubmission(value);
    return services.workspaceSnapshot.complete(submission.requestId, submission.workspaceState);
  });
  ipc.handle("agentdesk:get-codex-defaults", () => services.codexDefaults());
  ipc.handle("agentdesk:save-clipboard-image", (_event, input: unknown) => services.files.saveClipboardImage(input));
  ipc.handle("agentdesk:read-clipboard-text", () => services.files.readClipboardText());
  ipc.handle("agentdesk:write-clipboard-text", (_event, text: unknown) => services.files.writeClipboardText(text));
  ipc.handle("agentdesk:copy-image", (_event, dataUrl: unknown) => services.files.copyImage(dataUrl));
  ipc.handle("agentdesk:authorize-pasted-file", (_event, filePath: unknown) => services.files.authorizePastedFile(filePath));
  ipc.handle("agentdesk:save-text-file", (_event, input: unknown) => services.files.saveTextFile(input));
  ipc.handle("agentdesk:export-diagnostics", () => services.files.exportDiagnostics());
  ipc.handle("agentdesk:create-handoff", (_event, input: unknown) => services.files.createHandoff(input));
  ipc.handle("agentdesk:read-local-image", (_event, filePath: unknown) => services.files.readLocalImage(filePath));
  ipc.handle("agentdesk:open-local-path", (_event, filePath: unknown) => services.files.openLocalPath(filePath));
  ipc.handle("agentdesk:open-external", (_event, url: unknown) => services.files.openExternal(url));
  ipc.handle("agentdesk:open-external-terminal", (_event, input: unknown) => services.files.openExternalTerminal(input));
  ipc.handle("agentdesk:show-notification", (_event, input: unknown) => services.showNotification(input));
  ipc.handle("agentdesk:window-state", () => services.window.state());
  ipc.handle("agentdesk:window-minimize", () => services.window.minimize());
  ipc.handle("agentdesk:window-toggle-maximize", () => services.window.toggleMaximize());
  ipc.handle("agentdesk:update-status", () => services.desktopUpdate.status());
  ipc.handle("agentdesk:update-check", () => services.desktopUpdate.check());
  ipc.handle("agentdesk:update-download", () => services.desktopUpdate.download());
  ipc.handle("agentdesk:update-install", () => services.desktopUpdate.install());
  ipc.handle("agentdesk:cli-update-status", () => services.codexUpdate.status());
  ipc.handle("agentdesk:cli-update-check", () => services.codexUpdate.check());
  ipc.handle("agentdesk:cli-update-install", () => services.codexUpdate.install());
  ipc.handle("claude:runtime-status", () => services.claude.status());
  ipc.handle("claude:update-check", () => services.claude.checkUpdate());
  ipc.handle("claude:update-install", (_event, allowUnverified: unknown) => services.claude.installUpdate(allowUnverified === true));
  ipc.handle("agent:request", (_event, request: unknown) => services.agent.request(validateAgentRequest(request)));
  ipc.handle("agent:respond", (_event, response: unknown) => services.agent.respond(validateAgentResponse(response)));
  if (!services.development) return;
  ipc.handle("agentdesk:dev-claude-worker-hold-requests", () => services.development?.holdClaudeWorkerRequests());
  ipc.handle("agentdesk:dev-claude-worker-fatal", () => services.development?.injectClaudeWorkerFatal());
  ipc.handle("agentdesk:dev-claude-gateway-fixture", (_event, kind: unknown) => services.development?.setClaudeGatewayFixture(kind));
  ipc.handle("agentdesk:dev-claude-lifecycle-fixture", (_event, kind: unknown) => services.development?.setClaudeLifecycleFixture(kind));
  ipc.handle("agentdesk:dev-desktop-update-fixture", () => services.development?.setDesktopUpdateFixture());
  ipc.handle("agentdesk:dev-shutdown-dry-run", () => services.development?.shutdownDryRun());
  ipc.handle("agentdesk:dev-app-quit", () => services.development?.quitApp());
  ipc.handle("agentdesk:dev-claude-signature-fixture", (_event, kind: unknown) => services.development?.setClaudeSignatureFixture(kind));
}
