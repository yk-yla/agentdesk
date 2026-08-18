import { ArrowLeftToLine, ArrowRight, ArrowRightToLine, Download, FolderOpen, GitFork, Pencil, Pin, PinOff, Plus, Star, Trash2, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { AgentCapabilities, AgentOperation, AgentProvider } from "../shared/agentProtocol";
import { DEFAULT_BOSS_KEY } from "../shared/bossKey";
import { providerDisplayName } from "../shared/providerMetadata";
import { DEFAULT_BASE_FONT_SIZE, type BossKeyStatus, type ClaudeRuntimeStatus, type CodexCliUpdateStatus, type CompactionRecord, type CodexDefaults, type DesktopPreferences, type DesktopUpdateStatus, type JsonObject } from "../shared/protocol";
import {
  asRecord, basename, DEFAULT_DISPLAY_MODE, DEFAULT_THEME, emptySession, findModelOption,
  EMPTY_CODEX_DEFAULTS, normalizedDirectory, numberValue, sameDirectory, stringValue, upsertHistoryEntry,
  type CollaborationMode, type HistoryThread, type ImageAttachment, type LayoutState, type ModelOption, type PaneState, type PendingSteerMessage, type QueuedMessage, type SessionState, type SkillOption,
} from "./domain";
import { AgentClient } from "./agent/AgentClient";
import {
  agentEventPayload, applyAgentEvent, goalFromAgentValue, hydrateAgentSession, normalizeAgentModel,
  type RoutedAgentEvent,
} from "./agent/AgentEventRouter";
import { createClaudeModelCache, sameClaudeModelCache } from "./agent/claudeModelCache";
import { codexRequestMethod, isCodexActiveWriterConflict, isCodexRequestTimeout, mergeMessages } from "./inputQueue";
import {
  applyProviderModelDefaults, initialProviderCapabilities, initialProviderModels, newSessionDefaults, normalizeAgentRequestError, retargetEmptySession,
  providerDisconnectedMessage,
} from "./agent/providerRegistry";
import { createMockAgentBridge } from "./mockBridge";
import PaneView from "./PaneView";
import { appendRawEvent, clearRawEvents } from "./rawEventStore";
import Sidebar, { type HistoryAction, type SidebarProps } from "./Sidebar";
import { handoffMarkdown, sessionMarkdown } from "./sessionTools";
import { authorizeRestoredSessionWorkspaces, createWorkspaceState, loadSavedImages, parseWorkspaceState, workspaceStateFingerprint } from "./workspaceState";
import { SessionSettingsCoordinator } from "./sessionSettingsCoordinator";
import { recoverProviderSessions } from "./providerRecovery";
import { SessionLifecycleController } from "./sessionLifecycleController";
import { SessionMessageController } from "./sessionMessageController";
import { SessionTitleController } from "./sessionTitleController";
import { nativeSessionKey, ProviderEventController } from "./providerEventController";
import { applyLocalSessionMetadata, favoriteHistoryEntries, favoriteSessionSummary, HistoryController, isFavoriteSession, mergeHistory, sortHistory, sortHistoryByRecency } from "./historyController";
import { registerHistoricalWorkspace, restoreHistoricalSession } from "./historicalSessionRestore";
import { LayoutController, type TabDropPosition, type TabDropTarget } from "./layoutController";
import WindowTitleBar from "./WindowTitleBar";
import ProviderIcon from "./ProviderIcon";
import { closeSessionResources } from "./sessionLifecycle";
import { installRendererDiagnostics, trackUiEvent } from "./rendererDiagnostics";
import { initializeProviders, providerCanRestore, type ProviderStartupState } from "./providerInitialization";
import type { CommandUsage } from "./commandSuggestions";
import { TurnTelemetry } from "./turnTelemetry";
import { PreferenceSaveCoordinator } from "./preferenceSaveCoordinator";

const PluginPanel = lazy(() => import("./PluginPanel"));

declare const __CODEX_BROWSER_PREVIEW__: boolean;

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MODEL_CONTEXT_WINDOW_CACHE_ENTRIES = 256;
/** 稳定的空数组，避免每次渲染给分栏传入新引用而击穿 memo。 */
const NO_ATTACHMENTS: ImageAttachment[] = [];
const NO_QUEUED_MESSAGES: QueuedMessage[] = [];
const NO_PENDING_STEERS: PendingSteerMessage[] = [];
const NO_SKILLS: SkillOption[] = [];
const READ_ONLY_SESSION_OPERATIONS = new Set<AgentOperation>([
  "readSession", "resumeSession", "getGoal", "readRateLimits", "listMcpServers", "listSkills", "closeSession",
]);
const INITIAL_UPDATE_STATUS: DesktopUpdateStatus = { phase: "idle", currentVersion: "", message: "仅在手动检查时连接公开 GitHub。", repositoryUrl: "https://github.com/yk-yla/agentdesk" };
const INITIAL_CLI_UPDATE_STATUS: CodexCliUpdateStatus = { phase: "idle", currentVersion: "", message: "正在读取 Codex CLI 版本。" };
const INITIAL_CLAUDE_RUNTIME_STATUS: ClaudeRuntimeStatus = { phase: "idle", binarySource: "sdk", binaryVersion: "", sdkVersion: "", credentialsAvailable: false, credentialSource: "unavailable", credentialMessage: "正在读取 Claude 配置。", message: "仅在手动检查时连接 Claude Code 发布源。" };
const INITIAL_BOSS_KEY_STATUS: BossKeyStatus = { accelerator: DEFAULT_BOSS_KEY, registered: false, message: "正在检查老板键。" };
const DEFAULT_SIDEBAR_WIDTH = 250;
const MIN_SIDEBAR_WIDTH = 184;
const MAX_SIDEBAR_WIDTH = 480;
function providerDirectoryKey(provider: AgentProvider, cwd: string) {
  return `${provider}:${normalizedDirectory(cwd)}`;
}

function clampSidebarWidth(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(value)))
    : DEFAULT_SIDEBAR_WIDTH;
}

function sidebarWidthFromPointer(clientX: number) {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(clientX)));
}

function sessionHasActiveWork(session: SessionState | undefined) {
  return Boolean(session && (session.status === "working" || session.activeTurnId || session.pendingApprovals.length));
}

interface TabContextMenuState {
  paneId: string;
  sessionId: string;
  x: number;
  y: number;
}

function useAgentBridge() {
  return useMemo(() => {
    if (window.agentDesk) return window.agentDesk;
    if (import.meta.env.DEV || __CODEX_BROWSER_PREVIEW__) return createMockAgentBridge();
    throw new Error("Agent Bridge 加载失败，请重新启动客户端。");
  }, []);
}

function cachedModelContextWindow(preferences: DesktopPreferences, model: string) {
  const tokens = preferences.modelContextWindows?.[model]?.tokens;
  return Number.isSafeInteger(tokens) && Number(tokens) > 0 ? Number(tokens) : null;
}

function claudeVersionForCache(status: ClaudeRuntimeStatus) {
  return status.sdkVersion.trim() || status.binaryVersion.trim() || "unknown";
}

function tokenUsageForModel(session: SessionState, model: string, preferences: DesktopPreferences) {
  if (model === session.model && session.tokenUsage.total !== null) return session.tokenUsage;
  const total = cachedModelContextWindow(preferences, model);
  return total === session.tokenUsage.total ? session.tokenUsage : { ...session.tokenUsage, total };
}

function compactionKey(provider: AgentProvider, nativeSessionId: string) {
  return `${provider}:${nativeSessionId}`;
}

function persistedCompaction(preferences: DesktopPreferences, session: Pick<SessionState, "provider" | "threadId">) {
  if (!session.threadId) return undefined;
  const key = compactionKey(session.provider, session.threadId);
  return preferences.compactionCounts?.[key] || preferences.codexCompactionCounts?.[key];
}

function withPersistedCompaction(session: SessionState, preferences: DesktopPreferences) {
  const persisted = persistedCompaction(preferences, session);
  if (!persisted) return session;
  return {
    ...session,
    compactionCount: Math.max(session.compactionCount, persisted.count),
    compactionEventIds: [...new Set([...persisted.eventIds, ...session.compactionEventIds])].slice(-64),
  };
}

function updateCompactionCache(current: NonNullable<DesktopPreferences["compactionCounts"]>, key: string, record: CompactionRecord) {
  return Object.fromEntries(Object.entries({ ...current, [key]: record })
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, 512));
}

function skillsFromList(value: unknown, cwd: string): SkillOption[] {
  const data = Array.isArray(asRecord(value).data) ? asRecord(value).data as unknown[] : [];
  const requestedKey = normalizedDirectory(cwd);
  const entry = data.map(asRecord).find((candidate) => normalizedDirectory(stringValue(candidate.cwd)) === requestedKey) || asRecord(data[0]);
  const skills = Array.isArray(entry.skills) ? entry.skills : [];
  return skills.map((item) => {
    const skill = asRecord(item);
    const skillInterface = asRecord(skill.interface);
    const name = stringValue(skill.name).replace(/^\//, "");
    return {
      name,
      description: stringValue(skillInterface.shortDescription, stringValue(skill.shortDescription, stringValue(skill.description))),
      path: stringValue(skill.path, name ? `command:${name}` : ""),
      scope: stringValue(skill.scope, "user"),
      enabled: skill.enabled !== false,
    };
  }).filter((skill) => skill.name && skill.path && skill.enabled).sort((left, right) => left.name.localeCompare(right.name));
}

function rateWindowLine(label: string, value: unknown) {
  const window = asRecord(value);
  if (!Object.keys(window).length) return "";
  const usedPercent = Math.round(numberValue(window.usedPercent));
  const resetsAt = numberValue(window.resetsAt);
  const resetText = resetsAt ? `，${new Date(resetsAt * 1000).toLocaleString("zh-CN")} 重置` : "";
  return `${label}：已用 ${usedPercent}%${resetText}`;
}

export default function App() {
  const bridge = useAgentBridge();
  useEffect(() => installRendererDiagnostics(bridge), [bridge]);
  const agentClient = useMemo(() => new AgentClient(bridge), [bridge]);
  const [workspace, setWorkspace] = useState("正在连接工作区");
  const [sessions, setSessions] = useState<Record<string, SessionState>>({});
  const [layout, setLayout] = useState<LayoutState>({ panes: [{ id: "pane-1", tabIds: ["session-1"], activeTabId: "session-1" }], activePaneId: "pane-1" });
  const [history, setHistory] = useState<HistoryThread[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [recentHistoryCursor, setRecentHistoryCursor] = useState<string | null>(null);
  const [recentHistoryLoading, setRecentHistoryLoading] = useState(false);
  const [historySearchResults, setHistorySearchResults] = useState<HistoryThread[] | null>(null);
  const [historySearchLoading, setHistorySearchLoading] = useState(false);
  const [historySearchCursor, setHistorySearchCursor] = useState<string | null>(null);
  const [providerModels, setProviderModels] = useState<Record<AgentProvider, ModelOption[]>>(() => initialProviderModels());
  const [providerCapabilities, setProviderCapabilities] = useState<Record<AgentProvider, AgentCapabilities>>(() => initialProviderCapabilities());
  const [skillsByCwd, setSkillsByCwd] = useState<Record<string, SkillOption[]>>({});
  const [codexDefaults, setCodexDefaults] = useState<CodexDefaults>(EMPTY_CODEX_DEFAULTS);
  const [providerStartupStates, setProviderStartupStates] = useState<Record<AgentProvider, ProviderStartupState>>({ codex: "connecting", claude: "connecting" });
  const [preferences, setPreferences] = useState<DesktopPreferences>({ lastWorkspace: "", favoriteWorkspaces: [], theme: DEFAULT_THEME, displayMode: DEFAULT_DISPLAY_MODE, bossKey: DEFAULT_BOSS_KEY });
  const recentCommandUsage = (preferences.recentCommandUsage || {}) as CommandUsage;
  const [bossKeyStatus, setBossKeyStatus] = useState<BossKeyStatus>(INITIAL_BOSS_KEY_STATUS);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus>(INITIAL_UPDATE_STATUS);
  const [cliUpdateStatus, setCliUpdateStatus] = useState<CodexCliUpdateStatus>(INITIAL_CLI_UPDATE_STATUS);
  const [claudeRuntimeStatus, setClaudeRuntimeStatus] = useState<ClaudeRuntimeStatus>(INITIAL_CLAUDE_RUNTIME_STATUS);
  const [attachments, setAttachments] = useState<Record<string, ImageAttachment[]>>({});
  const [queuedMessages, setQueuedMessages] = useState<Record<string, QueuedMessage[]>>({});
  const [pendingSteers, setPendingSteers] = useState<Record<string, PendingSteerMessage[]>>({});
  const [draftRevisions, setDraftRevisions] = useState<Record<string, number>>({});
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(null);
  const [tabRenameTarget, setTabRenameTarget] = useState<{ sessionId: string; title: string } | null>(null);
  const [tabRenameName, setTabRenameName] = useState("");
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [tabDropPaneId, setTabDropPaneId] = useState<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<TabDropTarget | null>(null);
  const [pluginPanelOpen, setPluginPanelOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [workspaceStateReady, setWorkspaceStateReady] = useState(false);
  const [workspaceRestoreRevision, setWorkspaceRestoreRevision] = useState(0);

  // 所有回调都通过 ref 读取最新状态，这样回调本身保持稳定，memo 才能真正拦住分栏。
  const sessionsRef = useRef(sessions);
  const workspaceRef = useRef(workspace);
  const layoutRef = useRef(layout);
  const providerModelsRef = useRef(providerModels);
  const providerCapabilitiesRef = useRef(providerCapabilities);
  const skillsByCwdRef = useRef(skillsByCwd);
  const defaultsRef = useRef(codexDefaults);
  const attachmentsRef = useRef(attachments);
  const queuedMessagesRef = useRef(queuedMessages);
  const pendingSteersRef = useRef(pendingSteers);
  const preferencesRef = useRef(preferences);
  const providerStartupStatesRef = useRef(providerStartupStates);
  const preferenceSaveCoordinatorRef = useRef(new PreferenceSaveCoordinator());
  const claudeRuntimeStatusRef = useRef(claudeRuntimeStatus);
  const tabContextMenuRef = useRef(tabContextMenu);
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  sessionsRef.current = sessions;
  workspaceRef.current = workspace;
  layoutRef.current = layout;
  providerModelsRef.current = providerModels;
  providerCapabilitiesRef.current = providerCapabilities;
  skillsByCwdRef.current = skillsByCwd;
  defaultsRef.current = codexDefaults;
  attachmentsRef.current = attachments;
  queuedMessagesRef.current = queuedMessages;
  pendingSteersRef.current = pendingSteers;
  preferencesRef.current = preferences;
  providerStartupStatesRef.current = providerStartupStates;
  claudeRuntimeStatusRef.current = claudeRuntimeStatus;
  tabContextMenuRef.current = tabContextMenu;
  sidebarCollapsedRef.current = sidebarCollapsed;

  const draftsRef = useRef(new Map<string, string>());
  const skillLoadsRef = useRef(new Map<string, Promise<void>>());
  const skillReloadTimersRef = useRef(new Map<AgentProvider, number>());
  const workspaceRestoreIdsRef = useRef(new Set<string>());
  const workspaceRestoreInFlightIdsRef = useRef(new Set<string>());
  const workspaceRestoreAttemptsRef = useRef(new Map<string, number>());
  const workspaceRestoreRetryTimersRef = useRef(new Map<string, number>());
  const sessionLifecycleRef = useRef(new SessionLifecycleController());
  const sessionMessageRef = useRef<SessionMessageController | null>(null);
  const sessionTitleRef = useRef<SessionTitleController | null>(null);
  const providerEventRef = useRef<ProviderEventController | null>(null);
  const turnTelemetryRef = useRef<TurnTelemetry | null>(null);
  const historyControllerRef = useRef<HistoryController | null>(null);
  const providerInitializationTasksRef = useRef(new Map<AgentProvider, Promise<void>>());
  const initializedProvidersRef = useRef(new Set<AgentProvider>());
  const layoutControllerRef = useRef<LayoutController | null>(null);
  const settingsCoordinatorRef = useRef(new SessionSettingsCoordinator());
  const workspaceRestoreInProgressRef = useRef(false);
  const workspaceStateReadyRef = useRef(false);
  const workspaceStateSaveTimerRef = useRef<number | undefined>(undefined);
  const lastWorkspaceStateFingerprintRef = useRef("");
  const workspaceRestoreStoppedIdsRef = useRef(new Set<string>());
  if (!turnTelemetryRef.current) turnTelemetryRef.current = new TurnTelemetry(trackUiEvent);

  useEffect(() => {
    if (!tabContextMenu) return undefined;
    const close = () => setTabContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [tabContextMenu]);

  useEffect(() => {
    if (!tabRenameTarget) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setTabRenameTarget(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [tabRenameTarget]);

  const displayMode = preferences.displayMode || DEFAULT_DISPLAY_MODE;
  const baseFontSize = preferences.baseFontSize ?? DEFAULT_BASE_FONT_SIZE;
  const activePane = layout.panes.find((pane) => pane.id === layout.activePaneId) ?? layout.panes[0];
  const activeSession = activePane ? sessions[activePane.activeTabId] : undefined;

  const updateSession = useCallback((id: string, updater: (current: SessionState) => SessionState) => {
    const currentSession = sessionsRef.current[id];
    if (!currentSession) return;
    const nextSession = updater(currentSession);
    sessionsRef.current = { ...sessionsRef.current, [id]: nextSession };
    setSessions((current) => {
      if (!current[id]) return current;
      return { ...current, [id]: current[id] === currentSession ? nextSession : updater(current[id]) };
    });
  }, []);

  const replaceQueuedMessages = useCallback((sessionId: string, nextOrUpdater: QueuedMessage[] | ((current: QueuedMessage[]) => QueuedMessage[])) => {
    const current = queuedMessagesRef.current[sessionId] || [];
    const next = typeof nextOrUpdater === "function" ? nextOrUpdater(current) : nextOrUpdater;
    const record = { ...queuedMessagesRef.current, [sessionId]: next };
    queuedMessagesRef.current = record;
    setQueuedMessages(record);
  }, []);

  const replaceAttachments = useCallback((sessionId: string, nextOrUpdater: ImageAttachment[] | ((current: ImageAttachment[]) => ImageAttachment[])) => {
    const current = attachmentsRef.current[sessionId] || [];
    const next = typeof nextOrUpdater === "function" ? nextOrUpdater(current) : nextOrUpdater;
    const record = { ...attachmentsRef.current, [sessionId]: next };
    attachmentsRef.current = record;
    setAttachments(record);
  }, []);

  const removeSessionAttachments = useCallback((sessionIds: Iterable<string>) => {
    const record = { ...attachmentsRef.current };
    for (const sessionId of sessionIds) delete record[sessionId];
    attachmentsRef.current = record;
    setAttachments(record);
  }, []);

  const replacePendingSteers = useCallback((sessionId: string, nextOrUpdater: PendingSteerMessage[] | ((current: PendingSteerMessage[]) => PendingSteerMessage[])) => {
    const current = pendingSteersRef.current[sessionId] || [];
    const next = typeof nextOrUpdater === "function" ? nextOrUpdater(current) : nextOrUpdater;
    const record = { ...pendingSteersRef.current, [sessionId]: next };
    pendingSteersRef.current = record;
    setPendingSteers(record);
  }, []);

  const setError = useCallback((sessionId: string, error: unknown, fallback: string) => {
    void bridge.writeLog({ level: "error", event: "renderer.session_error", details: { sessionId, fallback, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) } } }).catch(() => undefined);
    updateSession(sessionId, (current) => ({ ...current, errorText: error instanceof Error ? error.message : fallback }));
  }, [bridge, updateSession]);

  const ensureProviderInitialized = useCallback((provider: AgentProvider) => {
    if (initializedProvidersRef.current.has(provider)) return Promise.resolve();
    const currentTask = providerInitializationTasksRef.current.get(provider);
    if (currentTask) return currentTask;
    const setProviderState = (target: AgentProvider, state: Exclude<ProviderStartupState, "connecting">) => {
      providerStartupStatesRef.current = { ...providerStartupStatesRef.current, [target]: state };
      if (state === "ready") initializedProvidersRef.current.add(target);
      setProviderStartupStates(providerStartupStatesRef.current);
    };
    providerStartupStatesRef.current = { ...providerStartupStatesRef.current, [provider]: "connecting" };
    setProviderStartupStates(providerStartupStatesRef.current);
    const task = initializeProviders({
      loadCodexModels: async () => {
        const [value, defaults] = await Promise.all([
          agentClient.request("codex", "listModels", { limit: 100, includeHidden: false }),
          bridge.getCodexDefaults().catch(() => EMPTY_CODEX_DEFAULTS),
        ]);
        return { value, defaults };
      },
      loadCapabilities: (target) => agentClient.request(target, "getCapabilities") as Promise<AgentCapabilities>,
      isActive: () => true,
      applyCodexModels: ({ value, defaults }) => {
        defaultsRef.current = defaults;
        setCodexDefaults(defaults);
        const models = ((asRecord(value).data as unknown[]) || []).map((model) => normalizeAgentModel("codex", model));
        providerModelsRef.current = { ...providerModelsRef.current, codex: models };
        setProviderModels(providerModelsRef.current);
      },
      applyCapabilities: (target, capabilities) => {
        providerCapabilitiesRef.current = { ...providerCapabilitiesRef.current, [target]: capabilities };
        setProviderCapabilities(providerCapabilitiesRef.current);
        setSessions((current) => Object.fromEntries(Object.entries(current).map(([id, session]) => [id, session.provider === target ? { ...session, capabilities } : session])));
      },
      reportError: (target, phase, error) => {
        const providerName = target === "codex" ? "Codex" : "Claude Code";
        const phaseName = phase === "models" ? "模型列表" : "能力";
        const message = error instanceof Error ? `${providerName} ${phaseName}加载失败：${error.message}` : `${providerName} ${phaseName}加载失败。`;
        setSessions((current) => Object.fromEntries(Object.entries(current).map(([id, session]) => [id, session.provider === target ? { ...session, errorText: message } : session])));
      },
      setProviderState,
    }, [provider]).finally(() => providerInitializationTasksRef.current.delete(provider));
    providerInitializationTasksRef.current.set(provider, task);
    return task;
  }, [agentClient, bridge]);

  /**
   * 会话相关请求都走这里：响应和错误直接记入原始事件存储。
   * 这替代了原先主进程额外发一遍 client/routed-response 的做法，审计信息不变，IPC 少一次。
   */
  const requestForSession = useCallback(async (sessionId: string, operation: AgentOperation, params: JsonObject) => {
    const session = sessionsRef.current[sessionId];
    const provider = session?.provider || "codex";
    if (session?.readOnly && !READ_ONLY_SESSION_OPERATIONS.has(operation)) {
      throw new Error("当前会话正被其他程序使用，已切换为只读模式。");
    }
    const context = {
      sessionId,
      canonicalCwd: session?.cwd,
      nativeSessionId: session?.threadId || undefined,
      queryGeneration: session?.queryGeneration,
    };
    try {
      const value = await agentClient.request(provider, operation, params, context);
      appendRawEvent(sessionId, `response ${operation}`, { provider, payload: value });
      return value;
    } catch (error) {
      const normalized = normalizeAgentRequestError(provider, operation, error);
      appendRawEvent(sessionId, `error ${operation}`, { provider, message: normalized.message, ...(normalized instanceof Error && "payload" in normalized ? { payload: (normalized as { payload: unknown }).payload } : {}) });
      throw normalized;
    }
  }, [agentClient, bridge]);

  const requestForPluginPanel = useCallback((provider: AgentProvider, operation: AgentOperation, params: JsonObject) => {
    const sessionId = Object.keys(sessionsRef.current).find((id) => sessionsRef.current[id]?.provider === provider);
    const session = sessionId ? sessionsRef.current[sessionId] : undefined;
    const cwd = typeof params.cwd === "string" ? params.cwd : session?.cwd || workspace;
    const context = {
      ...(sessionId ? { sessionId } : {}),
      canonicalCwd: cwd,
      ...(session?.threadId ? { nativeSessionId: session.threadId } : {}),
      ...(session?.queryGeneration !== undefined ? { queryGeneration: session.queryGeneration } : {}),
    };
    return agentClient.request(provider, operation, { ...params, cwd }, context).catch(async (error) => {
      if (provider !== "claude") throw error;
      const normalized = normalizeAgentRequestError(provider, operation, error);
      throw normalized;
    });
  }, [agentClient, bridge, workspace]);

  const openPluginPanel = useCallback(() => setPluginPanelOpen(true), []);
  const closePluginPanel = useCallback(() => setPluginPanelOpen(false), []);

  const loadSkills = useCallback((sessionId: string, cwd: string, forceReload = false) => {
    if (!normalizedDirectory(cwd)) return Promise.resolve();
    const provider = sessionsRef.current[sessionId]?.provider || "codex";
    const key = providerDirectoryKey(provider, cwd);
    if (!key || (!forceReload && skillsByCwdRef.current[key])) return Promise.resolve();
    const existing = skillLoadsRef.current.get(key);
    if (existing) return existing;
    const load = requestForSession(sessionId, "listSkills", { cwds: [cwd], forceReload })
      .then((value) => {
        const next = { ...skillsByCwdRef.current, [key]: skillsFromList(value, cwd) };
        skillsByCwdRef.current = next;
        setSkillsByCwd(next);
      })
      .catch(() => {
        if (!skillsByCwdRef.current[key]) {
          const next = { ...skillsByCwdRef.current, [key]: NO_SKILLS };
          skillsByCwdRef.current = next;
          setSkillsByCwd(next);
        }
      })
      .finally(() => skillLoadsRef.current.delete(key));
    skillLoadsRef.current.set(key, load);
    return load;
  }, [requestForSession]);

  const createSessionState = useCallback((cwd: string, options?: { threadId?: string; title?: string; provider?: AgentProvider }) => {
    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const provider = options?.provider || "codex";
    const defaults = newSessionDefaults(provider, providerModelsRef.current[provider], defaultsRef.current, providerCapabilitiesRef.current[provider], preferencesRef.current.lastReasoningEfforts?.[provider]);
    const session = emptySession(id, cwd, defaults.model, defaults.effort, provider);
    session.capabilities = defaults.capabilities;
    session.tokenUsage.total = cachedModelContextWindow(preferencesRef.current, session.model);
    session.threadId = options?.threadId ?? null;
    session.title = options?.title || "新会话";
    session.titleOrigin = options?.title ? "provider" : "placeholder";
    session.resumed = false;
    const initialized = withPersistedCompaction(session, preferencesRef.current);
    sessionsRef.current = { ...sessionsRef.current, [id]: initialized };
    setSessions((current) => ({ ...current, [id]: initialized }));
    return id;
  }, []);

  const toggleSidebarCollapsed = useCallback(() => {
    trackUiEvent("sidebar.toggle");
    setSidebarCollapsed((collapsed) => !collapsed);
  }, []);

  const confirmCloseSessions = useCallback((sessionIds: string[]) => {
    const uniqueSessionIds = [...new Set(sessionIds)];
    const approvalCount = uniqueSessionIds.reduce((count, id) => count + (sessionsRef.current[id]?.pendingApprovals.length || 0), 0);
    const workingCount = uniqueSessionIds.filter((id) => sessionsRef.current[id]?.status === "working" || sessionsRef.current[id]?.pendingApprovals.length).length;
    if (!workingCount) return true;
    const subject = workingCount === 1 ? "1 个正在工作的会话" : `${workingCount} 个正在工作的会话`;
    const approvalNotice = approvalCount ? `，并取消 ${approvalCount} 个待处理请求` : "";
    return window.confirm(`${subject}即将关闭。确认后会停止任务${approvalNotice}并释放会话资源，确定关闭吗？`);
  }, []);

  const waitForSessionIdle = useCallback((sessionId: string, timeoutMs = 15_000) => new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      const current = sessionsRef.current[sessionId];
      if (!current || (current.status !== "working" && !current.activeTurnId)) { resolve(); return; }
      if (Date.now() - startedAt >= timeoutMs) { reject(new Error("等待任务停止超时。")); return; }
      window.setTimeout(check, 50);
    };
    check();
  }), []);

  const closeBackendSession = useCallback((sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    if (!session) return Promise.resolve();
    const context = { sessionId, canonicalCwd: session.cwd, nativeSessionId: session.threadId || undefined, queryGeneration: session.queryGeneration };
    updateSession(sessionId, (current) => ({ ...current, statusLabel: "正在关闭", errorText: "" }));
    return sessionLifecycleRef.current.close(sessionId, () => closeSessionResources({
      shouldInterrupt: session.status === "working" && Boolean(session.threadId && session.activeTurnId),
      shouldClose: Boolean(session.threadId),
      interrupt: async () => {
        await agentClient.request(session.provider, "interruptTurn", { threadId: session.threadId || "", turnId: session.activeTurnId || "" }, context);
      },
      waitForIdle: () => waitForSessionIdle(sessionId),
      close: async () => {
        await agentClient.request(session.provider, "closeSession", {}, context);
      },
    }).then((result) => {
      const error = result.fatalError;
      if (!error) return;
      updateSession(sessionId, (current) => ({ ...current, statusLabel: result.closeError ? "关闭失败" : "停止任务失败", errorText: error instanceof Error ? error.message : "关闭会话失败。" }));
      throw error;
    }));
  }, [agentClient, updateSession, waitForSessionIdle]);

  const releaseSessionState = useCallback((sessionId: string, reason = "会话已关闭。") => {
    setSessions((current) => { const next = { ...current }; delete next[sessionId]; sessionsRef.current = next; return next; });
    removeSessionAttachments([sessionId]);
    const nextQueued = { ...queuedMessagesRef.current }; delete nextQueued[sessionId]; queuedMessagesRef.current = nextQueued; setQueuedMessages(nextQueued);
    const nextSteers = { ...pendingSteersRef.current }; delete nextSteers[sessionId]; pendingSteersRef.current = nextSteers; setPendingSteers(nextSteers);
    setDraftRevisions((current) => { const next = { ...current }; delete next[sessionId]; return next; });
    draftsRef.current.delete(sessionId);
    sessionMessageRef.current?.release(sessionId);
    sessionTitleRef.current?.release(sessionId);
    providerEventRef.current?.release(sessionId);
    sessionLifecycleRef.current.release(sessionId, reason);
    settingsCoordinatorRef.current.delete(sessionId);
    clearRawEvents(sessionId);
  }, [removeSessionAttachments]);

  if (!layoutControllerRef.current) {
    layoutControllerRef.current = new LayoutController({
      getLayout: () => layoutRef.current,
      updateLayout: (updater) => setLayout((current) => {
        const next = updater(current);
        layoutRef.current = next;
        return next;
      }),
      getSession: (sessionId) => sessionsRef.current[sessionId],
    }, {
      createSession: createSessionState,
      confirmClose: confirmCloseSessions,
      closeSession: closeBackendSession,
      releaseSession: releaseSessionState,
      closeContextMenu: () => setTabContextMenu(null),
    });
  }
  const layoutController = layoutControllerRef.current;
  const {
    addSession, addSessionToPane, activateSession, focusPane, setActiveTab, removeTab, closeTabIds,
    splitPane, closePane, closeActiveTab, moveTab,
  } = layoutController;

  const openTabContextMenu = useCallback((event: MouseEvent<HTMLButtonElement>, paneId: string, sessionId: string) => {
    event.preventDefault();
    setTabContextMenu({ paneId, sessionId, x: event.clientX, y: event.clientY });
  }, []);

  const activateTab = useCallback((paneId: string, sessionId: string) => {
    setTabContextMenu(null);
    setActiveTab(paneId, sessionId);
    const selected = sessionsRef.current[sessionId];
    if (selected) trackUiEvent("tab.switch", { provider: selected.provider });
    const session = selected;
    if (session?.cwd && !sameDirectory(workspaceRef.current, session.cwd)) setWorkspace(session.cwd);
    if (workspaceRestoreIdsRef.current.has(sessionId)) setWorkspaceRestoreRevision((current) => current + 1);
  }, [setActiveTab]);

  const activateSessionTab = useCallback((sessionId: string) => {
    setTabContextMenu(null);
    activateSession(sessionId);
    const session = sessionsRef.current[sessionId];
    if (session?.cwd && !sameDirectory(workspaceRef.current, session.cwd)) setWorkspace(session.cwd);
  }, [activateSession]);

  const clearSession = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    if (!session) return;
    // /clear is a lifecycle operation: stop the active Query first, including
    // pending approvals, then replace the client session only after resources
    // have been released successfully.
    try { await closeBackendSession(sessionId); } catch { return false; }
    const nextSessionId = createSessionState(session.cwd, { provider: session.provider });
    layoutController.replaceSession(sessionId, nextSessionId);
    releaseSessionState(sessionId, "会话已清空。");
    return true;
  }, [closeBackendSession, createSessionState, layoutController, releaseSessionState]);

  const appendSystemMessage = useCallback((sessionId: string, text: string) => {
    updateSession(sessionId, (current) => ({
      ...current,
      messages: [...current.messages, { id: `system-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, role: "system", text, images: [] }],
      updatedAt: Date.now(),
    }));
  }, [updateSession]);

  useEffect(() => {
    const handleCloseTab = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.key.toLowerCase() !== "w") return;
      event.preventDefault();
      closeActiveTab();
    };
    window.addEventListener("keydown", handleCloseTab);
    return () => window.removeEventListener("keydown", handleCloseTab);
  }, [closeActiveTab]);

  const savePreference = useCallback(async (patch: Partial<DesktopPreferences>) => {
    const ticket = preferenceSaveCoordinatorRef.current.begin(patch);
    const previous = preferencesRef.current;
    const optimistic = { ...previous, ...patch };
    preferencesRef.current = optimistic;
    setPreferences((current) => ({ ...current, ...patch }));
    setHistory((current) => applyLocalSessionMetadata(current, optimistic));

    let next: DesktopPreferences;
    try {
      next = await bridge.savePreferences(patch);
    } catch (error) {
      const fields = Object.keys(patch).filter((field) => ["theme", "displayMode", "baseFontSize", "sidebarWidth", "bossKey"].includes(field));
      if (fields.length) trackUiEvent("preference.save_failed", { fields, errorName: error instanceof Error ? error.name : "unknown" });
      // If the write failed and no newer write replaced this field, restore the
      // last known persisted value before propagating the error to the caller.
      const rollback = preferenceSaveCoordinatorRef.current.accept(ticket, previous);
      if (Object.keys(rollback).length) {
        const merged = { ...preferencesRef.current, ...rollback };
        preferencesRef.current = merged;
        setPreferences((current) => ({ ...current, ...rollback }));
        setHistory((current) => applyLocalSessionMetadata(current, merged));
      }
      throw error;
    }
    const accepted = preferenceSaveCoordinatorRef.current.accept(ticket, next);
    if (!Object.keys(accepted).length) return;
    const merged = { ...preferencesRef.current, ...accepted };
    preferencesRef.current = merged;
    setPreferences((current) => ({ ...current, ...accepted }));
    setHistory((current) => applyLocalSessionMetadata(current, merged));
  }, [bridge]);

  const currentWorkspaceSnapshot = useCallback(() => {
    if (!workspaceStateReadyRef.current || workspaceRestoreInProgressRef.current) return null;
    const currentWorkspace = workspaceRef.current;
    if (!currentWorkspace || currentWorkspace === "正在连接工作区" || currentWorkspace === "工作区不可用") return null;
    return createWorkspaceState({
      workspace: currentWorkspace,
      layout: layoutRef.current,
      sessions: sessionsRef.current,
      drafts: draftsRef.current,
      attachments: attachmentsRef.current,
      queuedMessages: queuedMessagesRef.current,
      pendingSteers: pendingSteersRef.current,
      sidebarCollapsed: sidebarCollapsedRef.current,
    });
  }, []);

  const persistWorkspaceState = useCallback(async (force = false) => {
    const workspaceState = currentWorkspaceSnapshot();
    if (!workspaceState) return false;
    const fingerprint = workspaceStateFingerprint(workspaceState);
    if (!force && fingerprint === lastWorkspaceStateFingerprintRef.current) return true;
    await bridge.savePreferences({ workspaceState });
    lastWorkspaceStateFingerprintRef.current = fingerprint;
    return true;
  }, [bridge, currentWorkspaceSnapshot]);

  const scheduleWorkspaceStateSave = useCallback(() => {
    if (!workspaceStateReadyRef.current) return;
    if (workspaceStateSaveTimerRef.current !== undefined) window.clearTimeout(workspaceStateSaveTimerRef.current);
    workspaceStateSaveTimerRef.current = window.setTimeout(() => {
      workspaceStateSaveTimerRef.current = undefined;
      void persistWorkspaceState().catch((error) => bridge.writeLog({
        level: "warn",
        event: "renderer.workspace_snapshot.auto_save_failed",
        details: { message: error instanceof Error ? error.message : String(error) },
      }).catch(() => undefined));
    }, 750);
  }, [bridge, persistWorkspaceState]);

  useEffect(() => {
    if (!workspaceStateReady) return;
    scheduleWorkspaceStateSave();
  }, [attachments, layout, pendingSteers, queuedMessages, scheduleWorkspaceStateSave, sessions, sidebarCollapsed, workspace, workspaceStateReady]);

  useEffect(() => () => {
    if (workspaceStateSaveTimerRef.current !== undefined) window.clearTimeout(workspaceStateSaveTimerRef.current);
  }, []);

  useEffect(() => bridge.onWorkspaceSnapshotRequested((requestId) => {
    const workspaceState = currentWorkspaceSnapshot();
    if (!workspaceState) {
      void bridge.writeLog({ level: "warn", event: "renderer.workspace_snapshot.not_ready", details: { requestId } }).catch(() => undefined);
      return;
    }
    if (workspaceStateSaveTimerRef.current !== undefined) {
      window.clearTimeout(workspaceStateSaveTimerRef.current);
      workspaceStateSaveTimerRef.current = undefined;
    }
    void bridge.saveWorkspaceSnapshot(requestId, workspaceState).then(() => {
      lastWorkspaceStateFingerprintRef.current = workspaceStateFingerprint(workspaceState);
    }).catch((error) => bridge.writeLog({
      level: "warn",
      event: "renderer.workspace_snapshot.exit_save_failed",
      details: { requestId, message: error instanceof Error ? error.message : String(error) },
    }).catch(() => undefined));
  }), [bridge, currentWorkspaceSnapshot]);

  const rememberCommandUse = useCallback((key: string) => {
    const current = preferencesRef.current.recentCommandUsage || {};
    const latest = Object.values(current).reduce((max, value) => Math.max(max, value), 0);
    const timestamp = Math.max(Date.now(), latest + 1);
    const recentCommandUsage = Object.fromEntries(Object.entries({ ...current, [key]: timestamp })
      .sort((left, right) => right[1] - left[1])
      .slice(0, 512));
    preferencesRef.current = { ...preferencesRef.current, recentCommandUsage };
    setPreferences((currentPreferences) => ({ ...currentPreferences, recentCommandUsage }));
    void bridge.savePreferences({ recentCommandUsage }).catch(() => undefined);
  }, [bridge]);

  const rememberProviderEffort = useCallback((provider: AgentProvider, effort: string) => {
    if (!effort || preferencesRef.current.lastReasoningEfforts?.[provider] === effort) return;
    const lastReasoningEfforts = { ...preferencesRef.current.lastReasoningEfforts, [provider]: effort };
    preferencesRef.current = { ...preferencesRef.current, lastReasoningEfforts };
    setPreferences((current) => ({ ...current, lastReasoningEfforts }));
    void bridge.savePreferences({ lastReasoningEfforts }).catch(() => undefined);
  }, [bridge]);

  const setBossKey = useCallback(async (accelerator: string) => {
    const status = await bridge.setBossKey(accelerator);
    setBossKeyStatus(status);
    setPreferences((current) => ({ ...current, bossKey: status.accelerator }));
    return status;
  }, [bridge]);

  useEffect(() => {
    let active = true;
    void bridge.getBossKeyStatus()
      .then((status) => { if (active) setBossKeyStatus(status); })
      .catch(() => { if (active) setBossKeyStatus((current) => ({ ...current, registered: false, message: "读取老板键状态失败。" })); });
    return () => { active = false; };
  }, [bridge]);

  const favoriteHistory = useMemo(() => favoriteHistoryEntries(history, preferences), [history, preferences]);

  useEffect(() => {
    if (!preferences.favoriteSessions?.length) return;
    const summaries = { ...(preferences.favoriteSessionSummaries || {}) };
    let changed = false;
    for (const entry of history) {
      if (!isFavoriteSession(preferences, entry.provider, entry.id)) continue;
      const key = nativeSessionKey(entry.provider, entry.id);
      if (summaries[key]) continue;
      summaries[key] = favoriteSessionSummary(entry);
      changed = true;
    }
    if (changed) void savePreference({ favoriteSessionSummaries: summaries }).catch(() => undefined);
  }, [history, preferences, savePreference]);

  useEffect(() => {
    let active = true;
    const applyStatus = (status: ClaudeRuntimeStatus) => {
      claudeRuntimeStatusRef.current = status;
      if (active) setClaudeRuntimeStatus(status);
    };
    const unsubscribe = bridge.onClaudeRuntimeStatus((status) => applyStatus(status));
    void bridge.getClaudeRuntimeStatus().then((status) => applyStatus(status)).catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, [bridge]);

  useEffect(() => {
    const cache = preferencesRef.current.claudeModelCache;
    const version = claudeVersionForCache(claudeRuntimeStatus);
    if (!cache || version === "unknown" || cache.claudeVersion === "unknown" || cache.claudeVersion === version) return;
    setProviderModels((current) => ({ ...current, claude: initialProviderModels().claude }));
  }, [claudeRuntimeStatus]);

  const rememberModelContextWindow = useCallback((sessionId: string, event: RoutedAgentEvent) => {
    const payload = agentEventPayload(event);
    const tokens = event.provider === "claude" && event.envelope.type === "claude/contextUsage"
      ? payload.total
      : asRecord(payload.tokenUsage).modelContextWindow;
    if (!Number.isSafeInteger(tokens)) return;
    const model = sessionsRef.current[sessionId]?.model || "";
    if (!model || !Number.isSafeInteger(tokens) || Number(tokens) <= 0) return;
    const currentCache = preferencesRef.current.modelContextWindows || {};
    if (currentCache[model]?.tokens === tokens) return;
    const nextCache = Object.fromEntries(Object.entries({
      ...currentCache,
      [model]: { tokens: Number(tokens), updatedAt: Date.now() },
    }).sort((left, right) => right[1].updatedAt - left[1].updatedAt).slice(0, MAX_MODEL_CONTEXT_WINDOW_CACHE_ENTRIES));
    preferencesRef.current = { ...preferencesRef.current, modelContextWindows: nextCache };
    setPreferences((current) => ({ ...current, modelContextWindows: nextCache }));
    void bridge.savePreferences({ modelContextWindows: nextCache }).catch(() => undefined);
  }, [bridge]);

  const rememberCompaction = useCallback((sessionId: string, event: RoutedAgentEvent) => {
    const session = sessionsRef.current[sessionId];
    const payload = agentEventPayload(event);
    const eventId = event.provider === "codex"
      ? stringValue(asRecord(payload.item).id)
      : stringValue(payload.uuid, stringValue(payload.id, `${event.envelope.queryGeneration || 0}-${event.envelope.receivedAt}`));
    const nativeSessionId = session?.threadId || event.nativeSessionId || "";
    if (!session || !nativeSessionId || !eventId) return;
    const normalizedEventId = event.provider === "codex" ? eventId : `claude-compaction-${eventId}`;
    const key = compactionKey(event.provider, nativeSessionId);
    const current = preferencesRef.current.compactionCounts || preferencesRef.current.codexCompactionCounts || {};
    const previous = current[key] || { count: 0, eventIds: [], updatedAt: 0 };
    if (previous.eventIds.includes(normalizedEventId)) return;
    const nextRecord: CompactionRecord = {
      count: Math.max(previous.count, session.compactionCount) + 1,
      eventIds: [...previous.eventIds, normalizedEventId].slice(-64),
      updatedAt: Date.now(),
    };
    const next = updateCompactionCache(current, key, nextRecord);
    preferencesRef.current = { ...preferencesRef.current, compactionCounts: next };
    setPreferences((value) => ({ ...value, compactionCounts: next }));
    void bridge.savePreferences({ compactionCounts: next }).catch(() => undefined);
  }, [bridge]);

  const persistCompactionSnapshot = useCallback((sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    if (!session?.threadId) return;
    const key = compactionKey(session.provider, session.threadId);
    const current = preferencesRef.current.compactionCounts || preferencesRef.current.codexCompactionCounts || {};
    const previous = current[key] || { count: 0, eventIds: [], updatedAt: 0 };
    const nextRecord: CompactionRecord = {
      count: Math.max(previous.count, session.compactionCount),
      eventIds: [...new Set([...previous.eventIds, ...session.compactionEventIds])].slice(-64),
      updatedAt: Date.now(),
    };
    if (nextRecord.count === previous.count
      && nextRecord.eventIds.length === previous.eventIds.length
      && nextRecord.eventIds.every((id, index) => id === previous.eventIds[index])) return;
    const next = updateCompactionCache(current, key, nextRecord);
    preferencesRef.current = { ...preferencesRef.current, compactionCounts: next };
    setPreferences((value) => ({ ...value, compactionCounts: next }));
    void bridge.savePreferences({ compactionCounts: next }).catch(() => undefined);
  }, [bridge]);

  const updateClaudeModelCache = useCallback((models: ModelOption[]) => {
    const version = claudeVersionForCache(claudeRuntimeStatusRef.current);
    if (version === "unknown") return;
    const next = createClaudeModelCache(models, version);
    if (!next || sameClaudeModelCache(preferencesRef.current.claudeModelCache, next)) return;
    preferencesRef.current = { ...preferencesRef.current, claudeModelCache: next };
    setPreferences((current) => ({ ...current, claudeModelCache: next }));
    void bridge.savePreferences({ claudeModelCache: next }).catch(() => undefined);
  }, [bridge]);

  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    let nextWidth = sidebarWidthFromPointer(event.clientX);
    setSidebarWidth(nextWidth);
    document.body.classList.add("resizing-sidebar");
    trackUiEvent("sidebar.resize_started", { pointerType: event.pointerType, width: nextWidth });
    try { handle.setPointerCapture(pointerId); } catch { /* Window listeners still finish the gesture. */ }

    const resize = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      nextWidth = sidebarWidthFromPointer(pointerEvent.clientX);
      setSidebarWidth(nextWidth);
    };
    let finished = false;
    let timeoutId = 0;
    const cleanup = (reason: string) => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finishOnBlur);
      window.clearTimeout(timeoutId);
      document.body.classList.remove("resizing-sidebar");
      try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch { /* Capture may already be gone. */ }
      trackUiEvent("sidebar.resize_finished", { reason, width: nextWidth });
      void savePreference({ sidebarWidth: nextWidth }).catch(() => undefined);
    };
    const finish = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      cleanup(pointerEvent.type);
    };
    const finishOnBlur = () => cleanup("window_blur");

    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finishOnBlur);
    timeoutId = window.setTimeout(() => cleanup("timeout"), 30_000);
  }, [savePreference]);

  const checkForUpdates = useCallback(async () => {
    setUpdateStatus(await bridge.checkForUpdates());
  }, [bridge]);

  const checkCodexCliUpdates = useCallback(async () => {
    setCliUpdateStatus(await bridge.checkCodexCliUpdates());
  }, [bridge]);

  const updateCodexCli = useCallback(async () => {
    setCliUpdateStatus(await bridge.updateCodexCli());
  }, [bridge]);
  const checkClaudeCodeUpdates = useCallback(async () => {
    setClaudeRuntimeStatus(await bridge.checkClaudeCodeUpdates());
  }, [bridge]);
  const updateClaudeCode = useCallback(async () => {
    const hasActiveClaudeSession = Object.values(sessionsRef.current).some((session) => session.provider === "claude" && sessionHasActiveWork(session));
    if (hasActiveClaudeSession && !window.confirm("更新 Claude Code 会停止正在运行的 Claude 会话、Query、Worker 和后代进程，Codex 会话不会停止。确定继续吗？")) return;
    let status = await bridge.updateClaudeCode(false);
    if (!status.integrityVerified && status.phase === "available") {
      const signer = status.integritySigner || "未检测到签名者";
      if (!window.confirm(`无法验证 Claude 发布方完整性。\n\n签名者：${signer}\n\n只有你确认继续承担风险后才会安装，是否继续？`)) return;
      status = await bridge.updateClaudeCode(true);
    }
    setClaudeRuntimeStatus(status);
  }, [bridge]);
  const downloadUpdate = useCallback(async () => {
    setUpdateStatus(await bridge.downloadUpdate());
  }, [bridge]);

  const installUpdate = useCallback(async () => {
    if (workspaceRestoreInProgressRef.current) throw new Error("本地会话仍在恢复，请稍后再重启安装。");
    if (!await persistWorkspaceState(true)) throw new Error("当前会话现场尚未准备完成，请稍后再重启安装。");
    await bridge.installUpdate();
  }, [bridge, persistWorkspaceState]);
  const openUpdateRepository = useCallback(() => bridge.openExternal(updateStatus.repositoryUrl), [bridge, updateStatus.repositoryUrl]);

  const selectWorkspace = useCallback(async (directory: string) => {
    const registered = await bridge.registerWorkspace(directory);
    if (!registered) return;
    setWorkspace(registered);
    await savePreference({ lastWorkspace: registered });
  }, [bridge, savePreference]);

  const createSessionInDirectory = useCallback(async (
    directory: string,
    provider: AgentProvider = "codex",
    placement?: { paneId: string; afterSessionId?: string },
  ) => {
    const registered = await bridge.registerWorkspace(directory);
    if (!registered) return undefined;
    directory = registered;
    void ensureProviderInitialized(provider);
    setWorkspace(directory);
    const sessionId = placement
      ? addSessionToPane(placement.paneId, directory, { provider }, placement.afterSessionId)
      : addSession(directory, { provider });
    trackUiEvent("session.create", { provider, placement: placement ? "tab" : "pane" });
    void agentClient.request(provider, "getCapabilities", {}, { sessionId, canonicalCwd: directory })
      .then((value) => {
        const capabilities = value as SessionState["capabilities"];
        updateSession(sessionId, (current) => ({ ...current, capabilities }));
      })
      .catch((error) => setError(sessionId, error, "读取 Provider 能力失败"));
    void savePreference({ lastWorkspace: directory });
    return sessionId;
  }, [addSession, addSessionToPane, agentClient, bridge, ensureProviderInitialized, savePreference, setError, updateSession]);

  useEffect(() => {
    const handleNewSessionShortcut = (event: KeyboardEvent) => {
      if (event.altKey || (!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== "n") return;
      event.preventDefault();
      const provider: AgentProvider = event.shiftKey ? "claude" : "codex";
      void createSessionInDirectory(activeSession?.cwd || workspace, provider);
    };
    window.addEventListener("keydown", handleNewSessionShortcut);
    return () => window.removeEventListener("keydown", handleNewSessionShortcut);
  }, [activeSession?.cwd, createSessionInDirectory, workspace]);

  const chooseWorkspace = useCallback(async () => {
    trackUiEvent("workspace.choose");
    const next = await bridge.chooseWorkspace(workspace);
    if (next) await selectWorkspace(next);
  }, [bridge, selectWorkspace, workspace]);

  const chooseDirectoryForSession = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    if (!session || session.threadId) return;
    const next = await bridge.chooseWorkspace(session.cwd || workspace);
    if (!next) return;
    setWorkspace(next);
    await savePreference({ lastWorkspace: next });
    updateSession(sessionId, (current) => (current.threadId ? current : { ...current, cwd: next, updatedAt: Date.now() }));
  }, [bridge, savePreference, updateSession, workspace]);

  const openWindowsTerminal = useCallback((cwd: string) => {
    void bridge.openWindowsTerminal(cwd).catch((error) => {
      const pane = layoutRef.current.panes.find((entry) => entry.id === layoutRef.current.activePaneId);
      const sessionId = pane?.activeTabId;
      if (sessionId) setError(sessionId, error, "打开 Windows Terminal 失败");
    });
  }, [bridge, setError]);

  const openDirectoryInExplorer = useCallback((directory: string, sessionId?: string) => {
    void bridge.openLocalPath({ path: directory }).then((result) => {
      if (typeof result === "string" && result.trim()) throw new Error(result.trim());
    }).catch((error) => {
      const targetSessionId = sessionId || layoutRef.current.panes.find((entry) => entry.id === layoutRef.current.activePaneId)?.activeTabId;
      if (targetSessionId) setError(targetSessionId, error, "打开资源管理器失败");
    });
  }, [bridge, setError]);

  const toggleFavorite = useCallback(async (directory: string) => {
    const favorites = preferencesRef.current.favoriteWorkspaces;
    const alreadyFavorite = favorites.some((item) => sameDirectory(item, directory));
    await savePreference({ favoriteWorkspaces: alreadyFavorite ? favorites.filter((item) => !sameDirectory(item, directory)) : [directory, ...favorites] });
  }, [savePreference]);

  const setSessionSetting = useCallback(async (sessionId: string, field: "model" | "effort", value: string) => {
    const session = sessionsRef.current[sessionId];
    if (!session) return;
    const fallback = { model: session.model, effort: session.effort };
    settingsCoordinatorRef.current.initialize(sessionId, fallback);
    const currentTarget = settingsCoordinatorRef.current.desired(sessionId, fallback);
    if (session.capabilities[field === "model" ? "models" : "effort"] !== "supported") return;
    trackUiEvent(`session.${field}.change`, { provider: session.provider });
    const availableModels = providerModelsRef.current[session.provider];
    const selectedModel = field === "model" ? findModelOption(availableModels, value) : findModelOption(availableModels, currentTarget.model);
    const nextEffort = field === "model" && selectedModel && !selectedModel.efforts.includes(currentTarget.effort)
      ? selectedModel.defaultEffort
      : field === "effort" ? value : currentTarget.effort || selectedModel?.defaultEffort || "medium";
    const requested = { model: field === "model" ? value : selectedModel?.id || currentTarget.model, effort: nextEffort };
    updateSession(sessionId, (current) => {
      return {
        ...current,
        model: requested.model,
        ...(field === "model" ? { resolvedModel: undefined } : {}),
        effort: requested.effort,
        tokenUsage: tokenUsageForModel(current, requested.model, preferencesRef.current),
      };
    });
    if (!session.threadId) {
      settingsCoordinatorRef.current.setConfirmed(sessionId, requested);
      if (field === "effort") rememberProviderEffort(session.provider, requested.effort);
      return;
    }
    const request = settingsCoordinatorRef.current.enqueue(sessionId, requested, async (target) => {
      await requestForSession(sessionId, "updateSessionSettings", {
        threadId: session.threadId as string,
        model: target.model,
        effort: target.effort,
      });
    });
    try {
      await request.promise;
      if (request.isLatest()) {
        updateSession(sessionId, (current) => ({
          ...current,
          model: requested.model,
          effort: requested.effort,
          tokenUsage: tokenUsageForModel(current, requested.model, preferencesRef.current),
          errorText: "",
        }));
        if (field === "effort") rememberProviderEffort(session.provider, requested.effort);
      }
    } catch (error) {
      if (request.isLatest()) {
        const confirmed = settingsCoordinatorRef.current.confirmed(sessionId, fallback);
        updateSession(sessionId, (current) => ({
          ...current,
          model: confirmed.model,
          effort: confirmed.effort,
          tokenUsage: tokenUsageForModel(current, confirmed.model, preferencesRef.current),
          errorText: error instanceof Error ? error.message : "设置更新失败",
        }));
      }
    }
  }, [rememberProviderEffort, requestForSession, updateSession]);

  const setCollaborationMode = useCallback((sessionId: string, mode: CollaborationMode) => {
    updateSession(sessionId, (current) => ({ ...current, collaborationMode: mode }));
  }, [updateSession]);

  const cycleEffort = useCallback((sessionId: string, direction: 1 | -1) => {
    const session = sessionsRef.current[sessionId];
    if (!session) return;
    const target = settingsCoordinatorRef.current.desired(sessionId, { model: session.model, effort: session.effort });
    if (session.capabilities.effort !== "supported") return;
    const model = findModelOption(providerModelsRef.current[session.provider], target.model);
    const efforts = model?.efforts || [];
    if (!efforts.length) return;
    const index = Math.max(0, efforts.indexOf(target.effort || efforts[0]));
    const nextIndex = direction === 1 ? Math.min(efforts.length - 1, index + 1) : Math.max(0, index - 1);
    void setSessionSetting(sessionId, "effort", efforts[nextIndex]);
  }, [setSessionSetting]);

  const adoptStartedThread = useCallback((sessionId: string, value: unknown) => {
    const session = sessionsRef.current[sessionId];
    if (!session) throw new Error("会话不存在");
    const result = asRecord(value);
    const thread = asRecord(result.thread);
    const threadId = stringValue(thread.id);
    if (!threadId) throw new Error("没有拿到 Codex 会话 ID");
    const providerEvents = providerEventRef.current;
    if (!providerEvents) throw new Error("Provider 事件控制器尚未初始化");
    const existingOwner = providerEvents.sessionFor(session.provider, threadId);
    if (existingOwner && existingOwner !== sessionId) throw new Error("该会话已被其他 Tab 使用");
    providerEvents.bindSession(session.provider, threadId, sessionId);
    const model = stringValue(result.model, session.model);
    const effort = session.effort || stringValue(result.reasoningEffort, "medium");
    const pendingStart = providerEvents.takePendingStart(session.provider, threadId);
    if (pendingStart) appendRawEvent(sessionId, pendingStart.envelope.type, pendingStart.envelope);
    updateSession(sessionId, (current) => {
      const tokenUsage = tokenUsageForModel(current, model, preferencesRef.current);
      return pendingStart
        ? applyAgentEvent({ ...current, threadId, model, effort, resumed: true, tokenUsage }, pendingStart).session
        : { ...current, threadId, model, effort, resumed: true, tokenUsage };
    });
    settingsCoordinatorRef.current.setConfirmed(sessionId, { model, effort });
    return threadId;
  }, [updateSession]);

  const ensureThread = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    if (!session) throw new Error("会话不存在");
    if (session.readOnly) throw new Error("当前会话正被其他程序使用，已切换为只读模式。");
    return sessionLifecycleRef.current.ensureThread(sessionId, {
      threadId: session.threadId,
      resumed: session.resumed === true,
      claimExisting: session.threadId ? () => providerEventRef.current?.bindSession(session.provider, session.threadId as string, sessionId) : undefined,
      resume: session.threadId ? async () => {
        await requestForSession(sessionId, "resumeSession", { threadId: session.threadId, cwd: session.cwd });
        updateSession(sessionId, (current) => ({ ...current, resumed: true }));
      } : undefined,
      start: () => requestForSession(sessionId, "startSession", { cwd: session.cwd, model: session.model || null, sessionStartSource: "startup" }),
      adopt: (value) => adoptStartedThread(sessionId, value),
      isStartTimeout: (error) => isCodexRequestTimeout(error) && codexRequestMethod(error) === "startSession",
      onStartTimeout: () => {
          updateSession(sessionId, (current) => ({
            ...current,
            status: "working",
            statusLabel: "会话创建超时，等待后台确认",
            errorText: "不会重复创建会话；服务返回结果后将自动继续。",
          }));
      },
      onStartLateTimeout: () => requestForSession(sessionId, "closeSession", {}).then(() => undefined),
    });
  }, [adoptStartedThread, requestForSession, updateSession]);

  const restoreMessagesToDraft = useCallback((sessionId: string, messages: QueuedMessage[]) => {
    if (!messages.length) return;
    const existingText = draftsRef.current.get(sessionId) || "";
    const merged = mergeMessages(messages);
    const nextText = [merged.text, existingText].filter(Boolean).join("\n");
    if (nextText) draftsRef.current.set(sessionId, nextText);
    else draftsRef.current.delete(sessionId);
    replaceAttachments(sessionId, (current) => [...merged.images, ...current]);
    setDraftRevisions((current) => ({ ...current, [sessionId]: (current[sessionId] || 0) + 1 }));
  }, [replaceAttachments]);

  const showStatus = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    if (!session) return;
    const lines = [
      "**当前会话状态**",
      `- 目录：${session.cwd}`,
      `- Thread：${session.threadId || "尚未创建"}`,
      `- 模型：${session.model || "加载中"}`,
      ...(session.provider === "claude" ? [`- 实际模型：${session.resolvedModel || "等待 Claude 返回"}`] : []),
      `- 思考等级：${session.effort || "未设置"}`,
      `- 上下文：${session.tokenUsage.used}/${session.tokenUsage.total ?? "?"}`,
    ];
    try {
      const response = asRecord(await requestForSession(sessionId, "readRateLimits", {}));
      const limits = asRecord(response.rateLimits);
      const rateLines = [rateWindowLine("主要额度", limits.primary), rateWindowLine("次要额度", limits.secondary)].filter(Boolean);
      if (rateLines.length) lines.push("", "**使用额度**", ...rateLines.map((line) => `- ${line}`));
    } catch {
      lines.push("", "额度信息暂时不可用。");
    }
    appendSystemMessage(sessionId, lines.join("\n"));
  }, [appendSystemMessage, requestForSession]);

  const showMcpStatus = useCallback(async (sessionId: string) => {
    const response = asRecord(await requestForSession(sessionId, "listMcpServers", { limit: 100, detail: "toolsAndAuthOnly", threadId: sessionsRef.current[sessionId]?.threadId || null }));
    const servers = Array.isArray(response.data) ? response.data.map(asRecord) : [];
    if (!servers.length) {
      appendSystemMessage(sessionId, "**MCP 服务器**\n\n当前没有已配置的 MCP 服务器。");
      return;
    }
    const authLabels: Record<string, string> = { unsupported: "无需登录", notLoggedIn: "未登录", bearerToken: "令牌", oAuth: "OAuth" };
    const lines = servers.map((server) => {
      const tools = Object.keys(asRecord(server.tools)).length;
      const auth = stringValue(server.authStatus);
      return `- **${stringValue(server.name, "未命名服务器")}**：${tools} 个工具，${authLabels[auth] || auth || "状态未知"}`;
    });
    appendSystemMessage(sessionId, ["**MCP 服务器**", "", ...lines].join("\n"));
  }, [appendSystemMessage, requestForSession]);

  const applyResolvedSessionTitle = useCallback((sessionId: string, title: string) => {
    const session = sessionsRef.current[sessionId];
    if (!session?.threadId || !title) return;
    const updatedAt = Date.now();
    updateSession(sessionId, (current) => ({ ...current, title, titleOrigin: "provider", updatedAt }));
    setHistory((current) => sortHistory(current.map((entry) => entry.provider === session.provider && entry.id === session.threadId
      ? { ...entry, title, titleLower: title.toLowerCase(), updatedAt }
      : entry)));
    if (isFavoriteSession(preferencesRef.current, session.provider, session.threadId)) {
      const key = nativeSessionKey(session.provider, session.threadId);
      void savePreference({
        favoriteSessionSummaries: {
          ...(preferencesRef.current.favoriteSessionSummaries || {}),
          [key]: favoriteSessionSummary({ ...session, id: session.threadId, title, updatedAt }),
        },
      });
    }
  }, [savePreference, updateSession]);

  if (!sessionTitleRef.current) {
    sessionTitleRef.current = new SessionTitleController({
      getSession: (sessionId) => sessionsRef.current[sessionId],
    }, {
      request: requestForSession,
      applyTitle: applyResolvedSessionTitle,
      log: (level, event, details) => { void bridge.writeLog({ level, event, details }).catch(() => undefined); },
    });
  }

  if (!sessionMessageRef.current) {
    sessionMessageRef.current = new SessionMessageController({
      state: {
        getSession: (sessionId) => sessionsRef.current[sessionId],
        getQueued: (sessionId) => queuedMessagesRef.current[sessionId] || NO_QUEUED_MESSAGES,
        getPendingSteers: (sessionId) => pendingSteersRef.current[sessionId] || NO_PENDING_STEERS,
        getAttachments: (sessionId) => attachmentsRef.current[sessionId] || NO_ATTACHMENTS,
        getSkills: (provider, cwd) => skillsByCwdRef.current[providerDirectoryKey(provider, cwd)] || NO_SKILLS,
        updateSession,
        replaceQueued: replaceQueuedMessages,
        replacePendingSteers,
        replaceAttachments,
      },
      services: {
        request: requestForSession,
        ensureThread,
        clearSession: (sessionId) => { void clearSession(sessionId); },
        restoreMessagesToDraft,
        showStatus,
        showMcpStatus,
        rememberCommandUse,
        trackEvent: trackUiEvent,
        turnTelemetry: turnTelemetryRef.current,
        upsertHistory: (entry) => setHistory((current) => upsertHistoryEntry(current, entry)),
      },
    });
  }
  const sessionMessages = sessionMessageRef.current;
  const { runMessage, sendMessage, removeQueuedMessage, interrupt } = sessionMessages;

  useEffect(() => {
    void sessionMessages.drainQueues(Object.keys(queuedMessages));
  }, [queuedMessages, sessionMessages, sessions]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (tabContextMenuRef.current || document.querySelector(".image-lightbox")) return;
      const currentLayout = layoutRef.current;
      const pane = currentLayout.panes.find((entry) => entry.id === currentLayout.activePaneId) ?? currentLayout.panes[0];
      const session = pane ? sessionsRef.current[pane.activeTabId] : undefined;
      if (!session || session.status !== "working") return;
      event.preventDefault();
      void interrupt(session.id);
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [interrupt]);

  const respondToApproval = useCallback(async (sessionId: string, result: JsonObject) => {
    const approval = sessionsRef.current[sessionId]?.pendingApprovals[0];
    if (!approval) return;
    try {
      const session = sessionsRef.current[sessionId];
      await agentClient.respond({
        provider: session?.provider || "codex",
        sessionId,
        queryGeneration: approval.queryGeneration ?? session?.queryGeneration ?? 0,
        interactionId: approval.interactionId || String(approval.requestId),
        requestId: approval.requestId,
        ...(approval.toolUseId ? { toolUseId: approval.toolUseId } : {}),
      }, result);
      appendRawEvent(sessionId, `serverResponse ${approval.method}`, { requestId: approval.requestId, status: "submitted" });
      updateSession(sessionId, (current) => ({ ...current, pendingApprovals: current.pendingApprovals.filter((entry) =>
        (entry.interactionId || String(entry.requestId)) !== (approval.interactionId || String(approval.requestId))) }));
    } catch (error) {
      setError(sessionId, error, "请求响应失败");
    }
  }, [agentClient, setError, updateSession]);

  const compactSession = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    if (!session) return;
    updateSession(sessionId, (current) => ({ ...current, status: "working", statusLabel: "正在压缩", startedAt: Date.now(), errorText: "" }));
    try {
      const threadId = await ensureThread(sessionId);
      await requestForSession(sessionId, "compactSession", { threadId });
    } catch (error) {
      setError(sessionId, error, "压缩上下文失败");
    }
  }, [ensureThread, requestForSession, setError]);

  const loadGoal = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    if (!session?.threadId) return;
    try {
      const response = asRecord(await requestForSession(sessionId, "getGoal", { threadId: session.threadId }));
      updateSession(sessionId, (current) => ({ ...current, goal: goalFromAgentValue(current.provider, response.goal) }));
    } catch (error) {
      setError(sessionId, error, "读取目标失败");
    }
  }, [requestForSession, setError, updateSession]);

  const startGoal = useCallback(async (sessionId: string, objective: string) => {
    const session = sessionsRef.current[sessionId];
    const text = objective.trim();
    if (!session || !text || session.status === "working") return;
    try {
      const threadId = await ensureThread(sessionId);
      const response = asRecord(await requestForSession(sessionId, "setGoal", { threadId, objective: text, status: "active", tokenBudget: null }));
      const goal = goalFromAgentValue(session.provider, response.goal);
      if (!goal) throw new Error("服务端没有返回目标信息");
      updateSession(sessionId, (current) => ({ ...current, goal }));
      setHistory((current) => upsertHistoryEntry(current, { id: threadId, provider: session.provider, title: session.title, cwd: session.cwd }));
    } catch (error) {
      setError(sessionId, error, "开始目标失败");
    }
  }, [ensureThread, requestForSession, setError, updateSession]);

  const stopGoal = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    if (!session?.threadId || !session.goal) return;
    try {
      const response = asRecord(await requestForSession(sessionId, "setGoal", {
        threadId: session.threadId,
        objective: session.goal.objective,
        status: "paused",
        tokenBudget: null,
      }));
      const goal = goalFromAgentValue(session.provider, response.goal);
      if (!goal) throw new Error("服务端没有返回停止后的目标信息");
      updateSession(sessionId, (current) => ({ ...current, goal }));
      if (sessionsRef.current[sessionId]?.status === "working") await interrupt(sessionId);
    } catch (error) {
      setError(sessionId, error, "停止目标失败");
    }
  }, [interrupt, requestForSession, setError, updateSession]);

  const renameSession = useCallback(async (sessionId: string, requestedName: string) => {
    const session = sessionsRef.current[sessionId];
    if (!session) return;
    setTabContextMenu(null);
    const name = requestedName.trim();
    if (!name || name === session.title) return;
    sessionTitleRef.current?.invalidate(sessionId);
    try {
      if (session.threadId) await requestForSession(sessionId, "renameSession", { threadId: session.threadId, name });
      if (session.threadId) {
        const key = nativeSessionKey(session.provider, session.threadId);
        const patch: Partial<DesktopPreferences> = { sessionAliases: { ...(preferencesRef.current.sessionAliases || {}), [key]: name } };
        if (isFavoriteSession(preferencesRef.current, session.provider, session.threadId)) {
          patch.favoriteSessionSummaries = {
            ...(preferencesRef.current.favoriteSessionSummaries || {}),
            [key]: favoriteSessionSummary({ ...session, id: session.threadId, title: name, updatedAt: Date.now() }),
          };
        }
        await savePreference(patch);
      }
      updateSession(sessionId, (current) => ({ ...current, title: name, titleOrigin: "manual", updatedAt: Date.now() }));
      if (session.threadId) setHistory((current) => sortHistory(current.map((entry) => entry.provider === session.provider && entry.id === session.threadId ? { ...entry, title: name, titleLower: name.toLowerCase() } : entry)));
    } catch (error) {
      sessionTitleRef.current?.reset(sessionId);
      setError(sessionId, error, "重命名失败");
    }
  }, [requestForSession, savePreference, setError, updateSession]);

  const toggleThreadPin = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    setTabContextMenu(null);
    if (!session?.threadId) {
      if (session) setError(sessionId, new Error("发送第一条消息后才能置顶会话。"), "发送第一条消息后才能置顶会话。");
      return;
    }
    const nextPinned = !history.find((entry) => entry.provider === session.provider && entry.id === session.threadId)?.isPinned;
    try {
      await requestForSession(sessionId, "updateSessionMetadata", { threadId: session.threadId, isPinned: nextPinned });
      setHistory((current) => sortHistory(current.map((entry) => entry.provider === session.provider && entry.id === session.threadId ? { ...entry, isPinned: nextPinned } : entry)));
    } catch (error) {
      setError(sessionId, error, "置顶状态更新失败");
    }
  }, [history, requestForSession, setError]);

  const toggleSessionFavorite = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    setTabContextMenu(null);
    if (!session?.threadId) {
      if (session) setError(sessionId, new Error("发送第一条消息后才能收藏会话。"), "发送第一条消息后才能收藏会话。");
      return;
    }
    const current = preferencesRef.current.favoriteSessions || [];
    const key = nativeSessionKey(session.provider, session.threadId);
    const isFavorite = current.includes(key) || current.includes(session.threadId);
    const favoriteSessions = isFavorite ? current.filter((id) => id !== key && id !== session.threadId) : [...current, key];
    const favoriteSessionSummaries = { ...(preferencesRef.current.favoriteSessionSummaries || {}) };
    if (isFavorite) {
      delete favoriteSessionSummaries[key];
      delete favoriteSessionSummaries[session.threadId];
    } else {
      favoriteSessionSummaries[key] = favoriteSessionSummary({ ...session, id: session.threadId });
    }
    try {
      await savePreference({ favoriteSessions, favoriteSessionSummaries });
      setHistory((currentHistory) => sortHistory(currentHistory.map((entry) => entry.provider === session.provider && entry.id === session.threadId ? { ...entry, isFavorite: !isFavorite } : entry)));
    } catch (error) {
      setError(sessionId, error, "收藏状态更新失败");
    }
  }, [savePreference, setError]);

  const forkSession = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    setTabContextMenu(null);
    if (!session?.threadId) {
      if (session) setError(sessionId, new Error("发送第一条消息后才能创建分支。"), "发送第一条消息后才能创建分支。");
      return;
    }
    if (session.pendingApprovals.length) {
      setError(sessionId, new Error("请先处理当前审批，再创建分支。"), "请先处理当前审批，再创建分支。");
      return;
    }
    if (session.status === "working") {
      setError(sessionId, new Error("请等待当前任务结束后再创建分支。"), "请等待当前任务结束后再创建分支。");
      return;
    }
    try {
      const result = asRecord(await requestForSession(sessionId, "forkSession", { threadId: session.threadId, cwd: session.cwd }));
      const thread = asRecord(result.thread);
      const threadId = stringValue(thread.id);
      if (!threadId) throw new Error("没有拿到分支会话 ID");
      const title = `${session.title} 分支`;
      const cwd = stringValue(result.cwd, stringValue(thread.cwd, session.cwd));
      const forkedSessionId = addSession(cwd, { threadId, title, provider: session.provider });
      providerEventRef.current?.bindSession(session.provider, threadId, forkedSessionId);
      updateSession(forkedSessionId, (current) => ({
        ...hydrateAgentSession(current, session.provider, { ...thread, name: title }),
        threadId,
        title,
        model: stringValue(result.model) || session.model,
        effort: stringValue(result.reasoningEffort) || session.effort,
        resumed: false,
        tokenUsage: tokenUsageForModel(current, stringValue(result.model) || session.model, preferencesRef.current),
      }));
      persistCompactionSnapshot(forkedSessionId);
      setHistory((current) => upsertHistoryEntry(current, { id: threadId, provider: session.provider, title, cwd }));
      void requestForSession(forkedSessionId, "renameSession", { threadId, name: title }).catch((error) => setError(forkedSessionId, error, "分支重命名失败"));
    } catch (error) {
      setError(sessionId, error, "创建分支失败");
    }
  }, [addSession, persistCompactionSnapshot, requestForSession, setError, updateSession]);

  const deleteSession = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    setTabContextMenu(null);
    if (!session?.threadId) {
      if (session) setError(sessionId, new Error("当前会话还没有保存到本机历史。"), "当前会话还没有保存到本机历史。");
      return;
    }
    if (sessionHasActiveWork(session)) {
      setError(sessionId, new Error("正在运行的会话不可删除，请先停止任务并处理待处理请求。"), "正在运行的会话不可删除");
      return;
    }
    const providerTitle = providerDisplayName(session.provider);
    const title = session.title || `${providerTitle} 会话`;
    if (!window.confirm(`确认永久删除这条会话？\n\n${title}\n\n这会从本机 ${providerTitle} 历史中删除会话内容，不可恢复。`)) return;
    if (!window.confirm("最后确认：真的要永久删除这条本机会话吗？")) return;
    try {
      // The native history must not be deleted while a Query is still alive.
      await closeBackendSession(sessionId);
      await requestForSession(sessionId, "deleteSession", { threadId: session.threadId });
      const threadId = session.threadId;
      const key = nativeSessionKey(session.provider, threadId);
      const aliases = { ...(preferencesRef.current.sessionAliases || {}) };
      const favoriteSessionSummaries = { ...(preferencesRef.current.favoriteSessionSummaries || {}) };
      delete aliases[key];
      delete aliases[threadId];
      delete favoriteSessionSummaries[key];
      delete favoriteSessionSummaries[threadId];
      const compactionCounts = { ...(preferencesRef.current.compactionCounts || preferencesRef.current.codexCompactionCounts || {}) };
      delete compactionCounts[key];
      delete compactionCounts[threadId];
      const legacyCodexCompactionCounts = { ...(preferencesRef.current.codexCompactionCounts || {}) };
      if (session.provider === "codex") {
        delete legacyCodexCompactionCounts[key];
        delete legacyCodexCompactionCounts[threadId];
      }
      await savePreference({
        sessionAliases: aliases,
        favoriteSessions: (preferencesRef.current.favoriteSessions || []).filter((id) => id !== key && id !== threadId),
        favoriteSessionSummaries,
        compactionCounts,
        ...(session.provider === "codex" ? { codexCompactionCounts: legacyCodexCompactionCounts } : {}),
      });
      setHistory((current) => current.filter((entry) => entry.provider !== session.provider || entry.id !== threadId));
      const nextSessionId = createSessionState(session.cwd, { provider: session.provider });
      layoutController.replaceSession(sessionId, nextSessionId);
      releaseSessionState(sessionId, "会话已删除。");
    } catch (error) {
      setError(sessionId, error, "删除会话失败");
    }
  }, [closeBackendSession, createSessionState, layoutController, releaseSessionState, requestForSession, savePreference, setError]);

  const exportSession = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    if (!session) return;
    try {
      const result = await bridge.saveTextFile(sessionMarkdown(session), `${session.title || "codex-session"}.md`);
      if (result) appendSystemMessage(sessionId, `已导出 Markdown：${result.path}`);
    } catch (error) {
      setError(sessionId, error, "导出 Markdown 失败");
    }
  }, [appendSystemMessage, bridge, setError]);

  const handoffSession = useCallback(async (sessionId: string, targetProvider: AgentProvider) => {
    const session = sessionsRef.current[sessionId];
    if (!session) return;
    setTabContextMenu(null);
    try {
      if (session.status === "working" || session.pendingApprovals.length) {
        const targetName = targetProvider === "codex" ? "Codex" : "Claude Code";
        if (!window.confirm(`当前会话仍在工作。停止并交接到 ${targetName}？`)) return;
        if (session.status === "working") await interrupt(sessionId);
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const latest = sessionsRef.current[sessionId];
          if (!latest || (latest.status !== "working" && !latest.pendingApprovals.length)) break;
          await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
        const latest = sessionsRef.current[sessionId];
        if (latest?.status === "working" || latest?.pendingApprovals.length) throw new Error("原会话未能停止，交接材料已保留但未创建目标会话。" );
      }
      const packageInfo = await bridge.createHandoffPackage({
        cwd: session.cwd,
        title: session.title,
        threadId: session.threadId || "",
        content: handoffMarkdown(session),
      });
      const nextSessionId = await createSessionInDirectory(session.cwd, targetProvider);
      if (!nextSessionId) return;
      updateSession(nextSessionId, (current) => ({ ...current, title: `${session.title || "新会话"} 接力`, titleOrigin: "manual" }));
      const handoffMessage = sessionMessages.createQueuedMessage(packageInfo.prompt, "handoff");
      window.setTimeout(() => {
        void runMessage(nextSessionId, handoffMessage).then((accepted) => {
          if (!accepted) restoreMessagesToDraft(nextSessionId, [handoffMessage]);
        });
      }, 0);
      appendSystemMessage(sessionId, `已生成交接材料，并打开新的 ${targetProvider === "codex" ? "Codex" : "Claude Code"} 接力会话。`);
    } catch (error) {
      setError(sessionId, error, "创建交接材料失败");
    }
  }, [appendSystemMessage, bridge, createSessionInDirectory, interrupt, restoreMessagesToDraft, runMessage, sessionMessages, setError, updateSession]);

  if (!historyControllerRef.current) {
    historyControllerRef.current = new HistoryController({
      mergeEntries: (entries) => setHistory((current) => mergeHistory(current, entries)),
      setLoading: setHistoryLoading,
      setCursor: setHistoryCursor,
      setRecentLoading: setRecentHistoryLoading,
      setRecentCursor: setRecentHistoryCursor,
      setSearchResults: (entries, merge) => setHistorySearchResults((current) => merge ? mergeHistory(current || [], entries || []) : entries),
      setSearchLoading: setHistorySearchLoading,
      setSearchCursor: setHistorySearchCursor,
    }, {
      request: (provider, operation, params) => agentClient.request(provider, operation, params),
      getPreferences: () => preferencesRef.current,
      isVisible: () => document.visibilityState !== "hidden",
      log: (level, event, details) => { void bridge.writeLog({ level, event, details }).catch(() => undefined); },
    });
  }
  const historyController = historyControllerRef.current;
  const { refresh: refreshHistory, loadMore: loadMoreHistory, loadRecent: loadRecentHistory, loadMoreRecent: loadMoreRecentHistory, search: searchHistory, loadMoreSearch: loadMoreHistorySearch } = historyController;

  const openHistory = useCallback(async (entry: HistoryThread) => {
    const existing = Object.values(sessionsRef.current).find((session) => session.provider === entry.provider && session.threadId === entry.id && sameDirectory(session.cwd, entry.cwd));
    let registeredCwd: string;
    try {
      await ensureProviderInitialized(entry.provider);
      registeredCwd = await registerHistoricalWorkspace((cwd) => bridge.registerWorkspace(cwd), entry.cwd);
    } catch (error) {
      if (existing) {
        activateSessionTab(existing.id);
        setError(existing.id, error, "打开历史会话失败");
        return existing.id;
      }
      const currentLayout = layoutRef.current;
      const activePane = currentLayout.panes.find((pane) => pane.id === currentLayout.activePaneId) ?? currentLayout.panes[0];
      if (activePane) setError(activePane.activeTabId, error, "打开历史会话失败");
      return undefined;
    }
    if (existing) {
      activateSessionTab(existing.id);
      if (existing.resumed || existing.readOnly) return existing.id;
    }
    const currentLayout = layoutRef.current;
    const activePane = currentLayout.panes.find((pane) => pane.id === currentLayout.activePaneId) ?? currentLayout.panes[0];
    const placeholder = activePane ? sessionsRef.current[activePane.activeTabId] : undefined;
    const canReusePlaceholder = Boolean(
      placeholder
      && !placeholder.threadId
      && !placeholder.messages.length
      && !placeholder.activities.length
      && placeholder.status === "idle"
      && !(attachmentsRef.current[placeholder.id] || []).length
      && !draftsRef.current.get(placeholder.id),
    );
    const sessionId = existing?.id ?? (canReusePlaceholder && placeholder ? placeholder.id : addSession(registeredCwd, { threadId: entry.id, title: entry.title, provider: entry.provider }));
    if (!existing && canReusePlaceholder) {
      updateSession(sessionId, (current) => {
        const next = retargetEmptySession(
          current,
          entry.provider,
          registeredCwd,
          entry.id,
          entry.title,
          providerModelsRef.current[entry.provider],
          defaultsRef.current,
          providerCapabilitiesRef.current[entry.provider],
        );
        next.tokenUsage.total = cachedModelContextWindow(preferencesRef.current, next.model);
        return withPersistedCompaction(next, preferencesRef.current);
      });
    } else if (existing) {
      updateSession(sessionId, (current) => ({ ...current, cwd: registeredCwd, errorText: "" }));
    }
    providerEventRef.current?.bindSession(entry.provider, entry.id, sessionId);

    const readVersion = providerEventRef.current?.captureVersion(sessionId) || { event: 0, lifecycle: 0 };
    let resumed = false;
    const readHistoricalSession = () => requestForSession(sessionId, "readSession", { threadId: entry.id, includeTurns: true });
    const applyHistoricalRead = (readValue: unknown) => {
      const preserve = providerEventRef.current?.changedSince(sessionId, readVersion) || { preserveRealtime: false, preserveLifecycle: false };
      updateSession(sessionId, (current) => {
        const persisted = persistedCompaction(preferencesRef.current, current);
        return hydrateAgentSession(current, current.provider, asRecord(readValue).thread, {
          ...preserve,
          ...(persisted ? { persistedCompactionCount: persisted.count, persistedCompactionEventIds: persisted.eventIds } : {}),
        });
      });
      persistCompactionSnapshot(sessionId);
    };
    try {
      await restoreHistoricalSession({
        resume: () => sessionLifecycleRef.current.resume(sessionId, () => (
          requestForSession(sessionId, "resumeSession", { threadId: entry.id, cwd: registeredCwd })
        )),
        applyResume: (resumeValue) => {
          resumed = true;
          const resume = asRecord(resumeValue);
          updateSession(sessionId, (current) => {
            const model = stringValue(resume.model) || current.model;
            return { ...current, model, effort: stringValue(resume.reasoningEffort) || current.effort, resumed: true, tokenUsage: tokenUsageForModel(current, model, preferencesRef.current) };
          });
        },
        read: readHistoricalSession,
        applyRead: applyHistoricalRead,
      });
    } catch (error) {
      if (entry.provider === "codex" && !resumed && isCodexActiveWriterConflict(error)) {
        let readValue: unknown;
        try {
          readValue = await readHistoricalSession();
        } catch (readError) {
          setError(sessionId, readError, "读取被其他程序占用的历史会话失败");
          return sessionId;
        }
        updateSession(sessionId, (current) => ({
          ...current,
          readOnly: true,
          resumed: false,
          errorText: "该会话正被其他程序使用，当前为只读模式。",
        }));
        applyHistoricalRead(readValue);
      } else {
        setError(sessionId, error, "恢复或读取历史会话失败");
      }
    }
    return sessionId;
  }, [activateSessionTab, addSession, bridge, ensureProviderInitialized, persistCompactionSnapshot, requestForSession, setError, updateSession]);

  const retryReadOnlySession = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    if (!session?.readOnly || !session.threadId) return;
    try {
      await requestForSession(sessionId, "resumeSession", { threadId: session.threadId, cwd: session.cwd });
      const readValue = await requestForSession(sessionId, "readSession", { threadId: session.threadId, includeTurns: true });
      updateSession(sessionId, (current) => ({
        ...hydrateAgentSession(current, current.provider, asRecord(readValue).thread),
        readOnly: false,
        resumed: true,
        errorText: "",
      }));
    } catch (error) {
      if (session.provider === "codex" && isCodexActiveWriterConflict(error)) {
        updateSession(sessionId, (current) => ({ ...current, readOnly: true, errorText: "该会话仍被其他程序使用，当前为只读模式。" }));
      } else {
        setError(sessionId, error, "恢复会话失败");
      }
    }
  }, [requestForSession, setError, updateSession]);

  const isHistoryWorking = useCallback((threadId: string, provider?: AgentProvider) => (
    Object.values(sessionsRef.current).some((session) => session.threadId === threadId && (!provider || session.provider === provider) && sessionHasActiveWork(session))
  ), []);

  const runHistoryAction = useCallback(async (entry: HistoryThread, action: HistoryAction, value?: string) => {
    const existing = Object.values(sessionsRef.current).find((session) => session.provider === entry.provider && session.threadId === entry.id && sameDirectory(session.cwd, entry.cwd));
    if (existing) {
      if (action === "rename" && value) await renameSession(existing.id, value);
      else if (action === "pin") await toggleThreadPin(existing.id);
      else if (action === "favorite") await toggleSessionFavorite(existing.id);
      else if (action === "export") await exportSession(existing.id);
      else if (action === "handoffCodex") await handoffSession(existing.id, "codex");
      else if (action === "handoffClaude") await handoffSession(existing.id, "claude");
      else if (action === "fork") await forkSession(existing.id);
      else if (action === "delete") await deleteSession(existing.id);
      return;
    }

    const reportError = (error: unknown, fallback: string) => {
      const currentLayout = layoutRef.current;
      const pane = currentLayout.panes.find((candidate) => candidate.id === currentLayout.activePaneId) ?? currentLayout.panes[0];
      if (pane?.activeTabId) setError(pane.activeTabId, error, fallback);
    };
    const key = nativeSessionKey(entry.provider, entry.id);

    if (action === "favorite") {
      const favorites = preferencesRef.current.favoriteSessions || [];
      const isFavorite = favorites.includes(key) || favorites.includes(entry.id);
      const favoriteSessions = isFavorite ? favorites.filter((id) => id !== key && id !== entry.id) : [...favorites, key];
      const favoriteSessionSummaries = { ...(preferencesRef.current.favoriteSessionSummaries || {}) };
      if (isFavorite) {
        delete favoriteSessionSummaries[key];
        delete favoriteSessionSummaries[entry.id];
      } else {
        favoriteSessionSummaries[key] = favoriteSessionSummary(entry);
      }
      try {
        await savePreference({ favoriteSessions, favoriteSessionSummaries });
        setHistory((current) => sortHistory(current.map((candidate) => candidate.provider === entry.provider && candidate.id === entry.id ? { ...candidate, isFavorite: !isFavorite } : candidate)));
      } catch (error) {
        reportError(error, "收藏状态更新失败");
      }
      return;
    }

    try {
      const cwd = await registerHistoricalWorkspace((directory) => bridge.registerWorkspace(directory), entry.cwd);
      const params = { cwd, threadId: entry.id };
      const context = { canonicalCwd: cwd, nativeSessionId: entry.id };
      const readValue = await agentClient.request(entry.provider, "readSession", { ...params, includeTurns: true }, context);
      const seed = emptySession(`history-action-${Date.now()}`, cwd, "", "", entry.provider);
      seed.threadId = entry.id;
      seed.title = entry.title;
      const source = hydrateAgentSession(seed, entry.provider, asRecord(readValue).thread);
      source.threadId = entry.id;
      source.title = entry.title || source.title;

      if (action === "rename" && value) {
        const name = value.trim();
        if (!name || name === entry.title) return;
        await agentClient.request(entry.provider, "renameSession", { ...params, name }, context);
        const patch: Partial<DesktopPreferences> = { sessionAliases: { ...(preferencesRef.current.sessionAliases || {}), [key]: name } };
        if (isFavoriteSession(preferencesRef.current, entry.provider, entry.id)) {
          patch.favoriteSessionSummaries = {
            ...(preferencesRef.current.favoriteSessionSummaries || {}),
            [key]: favoriteSessionSummary({ ...entry, title: name, updatedAt: Date.now() }),
          };
        }
        await savePreference(patch);
        setHistory((current) => sortHistory(current.map((candidate) => candidate.provider === entry.provider && candidate.id === entry.id ? { ...candidate, title: name, titleLower: name.toLowerCase() } : candidate)));
      } else if (action === "pin") {
        const nextPinned = !entry.isPinned;
        await agentClient.request(entry.provider, "updateSessionMetadata", { ...params, isPinned: nextPinned }, context);
        setHistory((current) => sortHistory(current.map((candidate) => candidate.provider === entry.provider && candidate.id === entry.id ? { ...candidate, isPinned: nextPinned } : candidate)));
      } else if (action === "export") {
        await bridge.saveTextFile(sessionMarkdown(source), `${source.title || "agent-session"}.md`);
      } else if (action === "handoffCodex" || action === "handoffClaude") {
        const targetProvider: AgentProvider = action === "handoffCodex" ? "codex" : "claude";
        const packageInfo = await bridge.createHandoffPackage({ cwd, title: source.title, threadId: entry.id, content: handoffMarkdown(source) });
        const nextSessionId = await createSessionInDirectory(cwd, targetProvider);
        if (!nextSessionId) return;
        updateSession(nextSessionId, (current) => ({ ...current, title: `${source.title || "新会话"} 接力`, titleOrigin: "manual" }));
        const handoffMessage = sessionMessages.createQueuedMessage(packageInfo.prompt, "handoff");
        window.setTimeout(() => {
          void runMessage(nextSessionId, handoffMessage).then((accepted) => {
            if (!accepted) restoreMessagesToDraft(nextSessionId, [handoffMessage]);
          });
        }, 0);
      } else if (action === "fork") {
        const result = asRecord(await agentClient.request(entry.provider, "forkSession", params, context));
        const thread = asRecord(result.thread);
        const threadId = stringValue(thread.id);
        if (!threadId) throw new Error("没有拿到分支会话 ID");
        const title = `${source.title || entry.title} 分支`;
        const forkCwd = stringValue(result.cwd, stringValue(thread.cwd, cwd));
        const forkedSessionId = addSession(forkCwd, { threadId, title, provider: entry.provider });
        providerEventRef.current?.bindSession(entry.provider, threadId, forkedSessionId);
        updateSession(forkedSessionId, (current) => ({
          ...hydrateAgentSession(current, entry.provider, { ...thread, name: title }),
          threadId,
          title,
          model: stringValue(result.model) || source.model,
          effort: stringValue(result.reasoningEffort) || source.effort,
          resumed: false,
          tokenUsage: tokenUsageForModel(current, stringValue(result.model) || source.model, preferencesRef.current),
        }));
        persistCompactionSnapshot(forkedSessionId);
        setHistory((current) => upsertHistoryEntry(current, { id: threadId, provider: entry.provider, title, cwd: forkCwd }));
        void requestForSession(forkedSessionId, "renameSession", { threadId, name: title }).catch((error) => setError(forkedSessionId, error, "分支重命名失败"));
      } else if (action === "delete") {
        const providerTitle = providerDisplayName(entry.provider);
        if (!window.confirm(`确认永久删除这条会话？\n\n${entry.title}\n\n这会从本机 ${providerTitle} 历史中删除会话内容，不可恢复。`)) return;
        if (!window.confirm("最后确认：真的要永久删除这条本机会话吗？")) return;
        await agentClient.request(entry.provider, "deleteSession", params, context);
        const aliases = { ...(preferencesRef.current.sessionAliases || {}) };
        const favoriteSessionSummaries = { ...(preferencesRef.current.favoriteSessionSummaries || {}) };
        delete aliases[key]; delete aliases[entry.id]; delete favoriteSessionSummaries[key]; delete favoriteSessionSummaries[entry.id];
        const compactionCounts = { ...(preferencesRef.current.compactionCounts || preferencesRef.current.codexCompactionCounts || {}) };
        delete compactionCounts[key]; delete compactionCounts[entry.id];
        const legacyCodexCompactionCounts = { ...(preferencesRef.current.codexCompactionCounts || {}) };
        if (entry.provider === "codex") { delete legacyCodexCompactionCounts[key]; delete legacyCodexCompactionCounts[entry.id]; }
        await savePreference({
          sessionAliases: aliases,
          favoriteSessions: (preferencesRef.current.favoriteSessions || []).filter((id) => id !== key && id !== entry.id),
          favoriteSessionSummaries,
          compactionCounts,
          ...(entry.provider === "codex" ? { codexCompactionCounts: legacyCodexCompactionCounts } : {}),
        });
        setHistory((current) => current.filter((candidate) => candidate.provider !== entry.provider || candidate.id !== entry.id));
      }
    } catch (error) {
      reportError(normalizeAgentRequestError(entry.provider, action === "pin" ? "updateSessionMetadata" : action === "rename" ? "renameSession" : action === "delete" ? "deleteSession" : action === "fork" ? "forkSession" : "readSession", error), "历史会话操作失败");
    }
  }, [addSession, agentClient, bridge, createSessionInDirectory, deleteSession, exportSession, forkSession, handoffSession, persistCompactionSnapshot, renameSession, requestForSession, restoreMessagesToDraft, runMessage, savePreference, sessionMessages, setError, toggleSessionFavorite, toggleThreadPin, updateSession]);

  const addImages = useCallback(async (sessionId: string, files: File[]) => {
    const session = sessionsRef.current[sessionId];
    if (!session || session.capabilities.images !== "supported") {
      if (session) updateSession(sessionId, (current) => ({ ...current, errorText: session.capabilities.images === "temporarilyUnavailable" ? "图片输入暂不可用。" : "当前 Provider 不支持图片输入。" }));
      return;
    }
    const images = files.filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
    if (!images.length) {
      updateSession(sessionId, (current) => ({ ...current, errorText: "只支持 PNG、JPEG、GIF 或 WebP 图片。" }));
      return;
    }
    if (images.some((file) => file.size > MAX_IMAGE_BYTES)) {
      updateSession(sessionId, (current) => ({ ...current, errorText: "每张图片必须在 10 MB 以内。" }));
      return;
    }
    try {
      const saved = await Promise.all(images.map(async (file) => {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        return bridge.saveClipboardImage(dataUrl, file.name || "pasted-image");
      }));
      replaceAttachments(sessionId, (current) => [...current, ...saved]);
      updateSession(sessionId, (current) => ({ ...current, errorText: "" }));
    } catch (error) {
      setError(sessionId, error, "图片保存失败");
    }
  }, [bridge, replaceAttachments, setError, updateSession]);

  const removeImage = useCallback((sessionId: string, index: number) => {
    replaceAttachments(sessionId, (current) => current.filter((_, imageIndex) => imageIndex !== index));
  }, [replaceAttachments]);

  const getDraft = useCallback((sessionId: string) => draftsRef.current.get(sessionId) ?? "", []);
  const onDraftChange = useCallback((sessionId: string, value: string) => {
    if (value) draftsRef.current.set(sessionId, value);
    else draftsRef.current.delete(sessionId);
    scheduleWorkspaceStateSave();
  }, [scheduleWorkspaceStateSave]);

  const toggleDetails = useCallback((sessionId: string) => {
    updateSession(sessionId, (current) => ({ ...current, detailsOpen: !current.detailsOpen }));
  }, [updateSession]);

  const setDetailView = useCallback((sessionId: string, view: "activity" | "raw" | "goal" | "plan" | "agents") => {
    updateSession(sessionId, (current) => ({ ...current, detailView: view }));
    if (view === "goal") void loadGoal(sessionId);
  }, [loadGoal, updateSession]);

  const clearError = useCallback((sessionId: string) => {
    updateSession(sessionId, (current) => ({ ...current, errorText: "", ...(current.status === "error" && !current.activeTurnId ? { status: "idle" as const, statusLabel: "就绪" } : {}) }));
  }, [updateSession]);

  const recoverProvider = useCallback((provider: AgentProvider) => {
    const providerSessionIds = new Set(Object.values(sessionsRef.current).filter((session) => session.provider === provider).map((session) => session.id));
    if (!providerSessionIds.size) return;
    providerEventRef.current?.disconnectProvider(provider);
    sessionLifecycleRef.current.disconnect(providerSessionIds, new Error(providerDisconnectedMessage(provider)));
    sessionMessages.recoverProvider(providerSessionIds);
    for (const sessionId of providerSessionIds) {
      settingsCoordinatorRef.current.delete(sessionId);
    }
    const recoveredSessions = recoverProviderSessions(sessionsRef.current, provider);
    sessionsRef.current = recoveredSessions;
    setSessions(recoveredSessions);
    setProviderStartupStates((current) => {
      const next = { ...current, [provider]: "error" as const };
      providerStartupStatesRef.current = next;
      return next;
    });
  }, [sessionMessages]);

  const reloadProviderSkills = useCallback((provider: AgentProvider) => {
    const currentTimer = skillReloadTimersRef.current.get(provider);
    if (currentTimer !== undefined) window.clearTimeout(currentTimer);
    const timer = window.setTimeout(() => {
      skillReloadTimersRef.current.delete(provider);
      const nextSkills = Object.fromEntries(Object.entries(skillsByCwdRef.current).filter(([key]) => !key.startsWith(`${provider}:`)));
      skillsByCwdRef.current = nextSkills;
      setSkillsByCwd(nextSkills);
      const requested = new Set<string>();
      for (const session of Object.values(sessionsRef.current)) {
        const key = providerDirectoryKey(session.provider, session.cwd);
        if (session.provider !== provider || !normalizedDirectory(session.cwd) || requested.has(key) || session.capabilities.skills !== "supported") continue;
        requested.add(key);
        const pending = skillLoadsRef.current.get(key) || Promise.resolve();
        void pending.finally(() => loadSkills(session.id, session.cwd, true));
      }
    }, 500);
    skillReloadTimersRef.current.set(provider, timer);
  }, [loadSkills]);

  if (!providerEventRef.current) {
    providerEventRef.current = new ProviderEventController({
      state: {
        getSessions: () => sessionsRef.current,
        updateSession,
        updateSessions: (updater) => setSessions((current) => {
          const next = updater(current);
          sessionsRef.current = next;
          return next;
        }),
        getActiveSessionId: () => {
          const current = layoutRef.current;
          const pane = current.panes.find((entry) => entry.id === current.activePaneId) || current.panes[0];
          return pane?.activeTabId;
        },
        getWorkspace: () => workspaceRef.current,
      },
      runtime: {
        lifecycle: sessionLifecycleRef.current,
        messages: sessionMessages,
        settings: settingsCoordinatorRef.current,
      },
      services: {
        setReady: () => setProviderStartupStates((current) => ({ ...current, codex: "ready" })),
        removeHistory: (provider, nativeSessionId) => setHistory((current) => current.filter((entry) => entry.provider !== provider || entry.id !== nativeSessionId)),
        clearSession: (sessionId) => { void clearSession(sessionId); },
        recoverProvider,
        closeActiveTab: () => { void closeActiveTab(); },
        reloadSkills: reloadProviderSkills,
        activateSession: activateSessionTab,
        openWorkspace: (nextWorkspace, provider = "codex") => { void createSessionInDirectory(nextWorkspace, provider); },
        adoptStartedThread,
        loadSkills: (sessionId, cwd, forceReload) => { void loadSkills(sessionId, cwd, forceReload); },
        updateProviderModels: (provider, models) => {
          setProviderModels((current) => ({ ...current, [provider]: models }));
          if (provider === "claude") updateClaudeModelCache(models);
        },
        rememberModelContextWindow,
        rememberCompaction,
        refreshSessionTitle: (sessionId, turnStatus) => sessionTitleRef.current?.refreshAfterTurn(sessionId, turnStatus),
        appendRawEvent,
        showNotification: (session) => { void bridge.showNotification({ sessionId: session.id, provider: session.provider, sessionTitle: session.title }); },
        isDocumentFocused: () => document.hasFocus(),
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (handle) => window.cancelAnimationFrame(handle),
        turnTelemetry: turnTelemetryRef.current,
      },
    });
  }
  const providerEvents = providerEventRef.current;

  useEffect(() => {
    let active = true;
    void Promise.allSettled([bridge.getWorkspace(), bridge.getPreferences(), bridge.getLaunchProvider()]).then(async ([workspaceResult, preferencesResult, launchProviderResult]) => {
      if (!active) return;
      if (workspaceResult.status === "rejected") {
        const initial = emptySession("session-1", "");
        initial.status = "error";
        initial.statusLabel = "工作区读取失败";
        initial.errorText = workspaceResult.reason instanceof Error ? workspaceResult.reason.message : "无法读取当前工作区。";
        sessionsRef.current = { "session-1": initial };
        setSessions({ "session-1": initial });
        setWorkspace("工作区不可用");
        providerStartupStatesRef.current = { codex: "error", claude: "error" };
        setProviderStartupStates(providerStartupStatesRef.current);
        return;
      }
      const currentWorkspace = workspaceResult.value;
      const launchProvider = launchProviderResult.status === "fulfilled" ? launchProviderResult.value : null;
      const value = preferencesResult.status === "fulfilled" ? preferencesResult.value : preferencesRef.current;
      setWorkspace(currentWorkspace);
      preferencesRef.current = { ...preferencesRef.current, ...value };
      setPreferences(preferencesRef.current);
      const startupModels = initialProviderModels(value.claudeModelCache, claudeVersionForCache(claudeRuntimeStatusRef.current));
      setProviderModels((current) => ({ ...current, claude: startupModels.claude }));
      setHistory((current) => applyLocalSessionMetadata(current, value));
      const restored = parseWorkspaceState(value.workspaceState, currentWorkspace);
      if (!restored) {
        const initial = emptySession("session-1", currentWorkspace, "", "", launchProvider || "codex");
        sessionsRef.current = { "session-1": initial };
        setSessions({ "session-1": initial });
        if (preferencesResult.status === "rejected") {
          updateSession("session-1", (current) => ({ ...current, errorText: "本地偏好读取失败，已使用默认设置。" }));
        }
        workspaceStateReadyRef.current = true;
        setWorkspaceStateReady(true);
        void ensureProviderInitialized(initial.provider);
        return;
      }

      const restoredSessionsBase = restored.truncated
        ? Object.fromEntries(Object.entries(restored.sessions).map(([id, session]) => [id, {
          ...session,
          errorText: `会话现场已按本地大小上限截断，请检查草稿和附件。${restored.truncationReasons.length ? ` 原因：${restored.truncationReasons.join("、")}` : ""}`,
        }]))
        : restored.sessions;
      const preparedRestoredSessions = Object.fromEntries(Object.entries(restoredSessionsBase)
        .map(([id, session]) => [id, withPersistedCompaction(session, preferencesRef.current)]));
      const authorization = await authorizeRestoredSessionWorkspaces(preparedRestoredSessions, (cwd) => bridge.registerWorkspace(cwd));
      const restoredSessions = authorization.sessions;
      if (!active) return;
      sessionsRef.current = restoredSessions;
      layoutRef.current = restored.layout;
      draftsRef.current = restored.drafts;
      const restoredActivePane = restored.layout.panes.find((pane) => pane.id === restored.layout.activePaneId) || restored.layout.panes[0];
      const restoredActiveWorkspace = restoredActivePane ? restoredSessions[restoredActivePane.activeTabId]?.cwd : "";
      if (restoredActiveWorkspace) setWorkspace(restoredActiveWorkspace);
      workspaceRestoreIdsRef.current = new Set(restored.threadSessionIds.filter((sessionId) => !authorization.blockedSessionIds.has(sessionId)));
      workspaceRestoreInFlightIdsRef.current.clear();
      workspaceRestoreAttemptsRef.current.clear();
      workspaceRestoreStoppedIdsRef.current = new Set(restored.stoppedSessionIds);
      setSessions(restoredSessions);
      setLayout(restored.layout);
      setWorkspaceRestoreRevision((current) => current + 1);
      if (launchProvider) addSession(currentWorkspace, { provider: launchProvider });
      const restoredProviders = new Set<AgentProvider>(Object.values(restoredSessions).map((session) => session.provider));
      if (launchProvider) restoredProviders.add(launchProvider);
      restoredProviders.forEach((provider) => { void ensureProviderInitialized(provider); });
      setSidebarCollapsed(restored.sidebarCollapsed);
      if (restored.drafts.size) setDraftRevisions(Object.fromEntries([...restored.drafts.keys()].map((sessionId) => [sessionId, 1])));
      workspaceRestoreInProgressRef.current = true;
      try {
        const nextAttachments: Record<string, ImageAttachment[]> = {};
        for (const [sessionId, images] of Object.entries(restored.attachments)) {
          const loaded = await loadSavedImages(bridge, images);
          if (loaded.length) nextAttachments[sessionId] = loaded;
        }
        const nextQueuedMessages: Record<string, QueuedMessage[]> = {};
        for (const [sessionId, messages] of Object.entries(restored.queuedMessages)) {
          const loaded = await Promise.all(messages.map(async (message) => ({ ...message, images: await loadSavedImages(bridge, message.images) })));
          const valid = loaded.filter((message) => message.text || message.images.length);
          if (valid.length) nextQueuedMessages[sessionId] = valid;
        }
        if (!active) return;
        const mergedAttachments = { ...attachmentsRef.current };
        for (const [sessionId, restoredImages] of Object.entries(nextAttachments)) {
          const seen = new Set<string>();
          mergedAttachments[sessionId] = [...(mergedAttachments[sessionId] || []), ...restoredImages]
            .filter((image) => {
              const key = `${image.path}\0${image.name}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
        }
        attachmentsRef.current = mergedAttachments;
        setAttachments(mergedAttachments);
        for (const [sessionId, restoredMessages] of Object.entries(nextQueuedMessages)) {
          restoreMessagesToDraft(sessionId, restoredMessages);
        }
      } catch (error) {
        if (active) {
          setSessions((current) => Object.fromEntries(Object.entries(current).map(([id, session]) => [id, {
            ...session,
            errorText: error instanceof Error ? `本地会话恢复未完成：${error.message}` : "本地会话恢复未完成，下次启动会继续恢复。",
          }])));
        }
      } finally {
        workspaceRestoreInProgressRef.current = false;
        if (!active) return;
        workspaceStateReadyRef.current = true;
        setWorkspaceStateReady(true);
      }
    }).catch((error) => {
      if (!active) return;
      const currentWorkspace = workspaceRef.current === "正在连接工作区" ? "" : workspaceRef.current;
      const initial = emptySession("session-1", currentWorkspace);
      initial.status = "error";
      initial.statusLabel = "本地会话恢复失败";
      initial.errorText = error instanceof Error ? error.message : "本地会话恢复失败，请重新启动软件。";
      sessionsRef.current = { "session-1": initial };
      setSessions({ "session-1": initial });
      providerStartupStatesRef.current = { codex: "error", claude: "error" };
      setProviderStartupStates(providerStartupStatesRef.current);
    });
    return () => { active = false; };
  }, [addSession, bridge, ensureProviderInitialized, restoreMessagesToDraft, updateSession]);

  useEffect(() => {
    if (!workspaceRestoreIdsRef.current.size) return;
    for (const sessionId of [...workspaceRestoreIdsRef.current]) {
      const session = sessions[sessionId];
      if (!session?.threadId) {
        workspaceRestoreIdsRef.current.delete(sessionId);
        continue;
      }
      if (!providerCanRestore(providerStartupStates, session.provider)) continue;
      if (workspaceRestoreInFlightIdsRef.current.has(sessionId)) continue;
      workspaceRestoreInFlightIdsRef.current.add(sessionId);
      providerEventRef.current?.bindSession(session.provider, session.threadId, sessionId);
      const readVersion = providerEventRef.current?.captureVersion(sessionId) || { event: 0, lifecycle: 0 };
      void restoreHistoricalSession({
        resume: () => sessionLifecycleRef.current.resume(sessionId, () => (
          requestForSession(sessionId, "resumeSession", { threadId: session.threadId as string, cwd: session.cwd })
        )),
        applyResume: (resumeValue) => {
          const resume = asRecord(resumeValue);
          updateSession(sessionId, (current) => {
            const model = stringValue(resume.model) || current.model;
            return { ...current, model, effort: stringValue(resume.reasoningEffort) || current.effort, resumed: true, tokenUsage: tokenUsageForModel(current, model, preferencesRef.current) };
          });
        },
        read: () => requestForSession(sessionId, "readSession", { threadId: session.threadId as string, includeTurns: true }),
        applyRead: (readValue) => {
          const preserve = providerEventRef.current?.changedSince(sessionId, readVersion) || { preserveRealtime: false, preserveLifecycle: false };
          updateSession(sessionId, (current) => {
            const persisted = persistedCompaction(preferencesRef.current, current);
            const hydrated = hydrateAgentSession(current, current.provider, asRecord(readValue).thread, {
              ...preserve,
              ...(persisted ? { persistedCompactionCount: persisted.count, persistedCompactionEventIds: persisted.eventIds } : {}),
            });
            return workspaceRestoreStoppedIdsRef.current.has(sessionId) ? {
              ...hydrated,
              status: "idle",
              statusLabel: "任务已停止",
              activeTurnId: null,
              startedAt: null,
              errorText: current.errorText || "上次退出软件时正在执行的任务已停止，请重新发送或继续。",
            } : hydrated;
          });
          persistCompactionSnapshot(sessionId);
        },
      }).then(() => {
        workspaceRestoreIdsRef.current.delete(sessionId);
        workspaceRestoreAttemptsRef.current.delete(sessionId);
        workspaceRestoreStoppedIdsRef.current.delete(sessionId);
        const retryTimer = workspaceRestoreRetryTimersRef.current.get(sessionId);
        if (retryTimer !== undefined) window.clearTimeout(retryTimer);
        workspaceRestoreRetryTimersRef.current.delete(sessionId);
      }).catch((error) => {
        setError(sessionId, error, "恢复或读取上次会话失败");
        const attempt = (workspaceRestoreAttemptsRef.current.get(sessionId) || 0) + 1;
        workspaceRestoreAttemptsRef.current.set(sessionId, attempt);
        if (attempt > 2 || workspaceRestoreRetryTimersRef.current.has(sessionId)) return;
        const timer = window.setTimeout(() => {
          workspaceRestoreRetryTimersRef.current.delete(sessionId);
          if (workspaceRestoreIdsRef.current.has(sessionId)) setWorkspaceRestoreRevision((current) => current + 1);
        }, attempt * 750);
        workspaceRestoreRetryTimersRef.current.set(sessionId, timer);
      }).finally(() => {
        workspaceRestoreInFlightIdsRef.current.delete(sessionId);
      });
    }
  }, [persistCompactionSnapshot, providerStartupStates, requestForSession, sessions, setError, updateSession, workspaceRestoreRevision]);

  useEffect(() => () => {
    for (const timer of workspaceRestoreRetryTimersRef.current.values()) window.clearTimeout(timer);
    workspaceRestoreRetryTimersRef.current.clear();
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = bridge.onUpdateStatus((status) => { if (active) setUpdateStatus(status); });
    void bridge.getUpdateStatus()
      .then((status) => { if (active) setUpdateStatus(status); })
      .catch(() => { if (active) setUpdateStatus((current) => ({ ...current, phase: "error", message: "读取软件更新状态失败。" })); });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);

  useEffect(() => {
    let active = true;
    const unsubscribe = bridge.onCodexCliUpdateStatus((status) => { if (active) setCliUpdateStatus(status); });
    void bridge.getCodexCliUpdateStatus()
      .then((status) => { if (active) setCliUpdateStatus(status); })
      .catch(() => { if (active) setCliUpdateStatus((current) => ({ ...current, phase: "error", message: "读取 Codex CLI 更新状态失败。" })); });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);

  useEffect(() => {
    const requested = new Set<string>();
    for (const session of Object.values(sessions)) {
      const key = providerDirectoryKey(session.provider, session.cwd);
      if (!normalizedDirectory(session.cwd) || requested.has(key)) continue;
      requested.add(key);
      if (session.capabilities.skills === "supported") void loadSkills(session.id, session.cwd);
    }
  }, [loadSkills, sessions]);

  useEffect(() => {
    const unsubscribe = agentClient.onEvent(providerEvents.handleEnvelope);
    return () => {
      unsubscribe();
      providerEvents.flush();
    };
  }, [agentClient, providerEvents]);

  useEffect(() => {
    setSessions((current) => Object.fromEntries(Object.entries(current).map(([id, session]) => {
      const withDefaults = applyProviderModelDefaults(session, providerModels[session.provider], codexDefaults, preferences.lastReasoningEfforts?.[session.provider]);
      const model = withDefaults.model;
      if (!model) return [id, session];
      const tokenUsage = tokenUsageForModel(session, model, preferences);
      if (withDefaults === session && tokenUsage === session.tokenUsage) return [id, session];
      return [id, {
        ...withDefaults,
        model,
        tokenUsage,
      }];
    })));
  }, [providerModels, codexDefaults, preferences]);

  useEffect(() => {
    return historyController.loadInitial(workspace);
  }, [historyController, workspace]);

  useEffect(() => {
    const refresh = () => { void refreshHistory(); };
    const interval = window.setInterval(refresh, 120_000);
    const onFocus = () => refresh();
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshHistory]);

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme || DEFAULT_THEME;
  }, [preferences.theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--font-size-base", `${baseFontSize}px`);
  }, [baseFontSize]);

  useEffect(() => {
    setSidebarWidth(clampSidebarWidth(preferences.sidebarWidth));
  }, [preferences.sidebarWidth]);

  useEffect(() => {
    if (activeSession?.cwd && !sameDirectory(workspaceRef.current, activeSession.cwd)) setWorkspace(activeSession.cwd);
  }, [activeSession?.id, activeSession?.cwd]);

  const activeTabsKey = layout.panes.map((pane) => `${pane.id}:${pane.activeTabId}:${pane.tabIds.length}`).join("|");
  useEffect(() => {
    let frame: number | null = null;
    const revealActiveTabs = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        document.querySelectorAll<HTMLElement>(".pane-tab-group .tab.active").forEach((tab) => {
          tab.scrollIntoView({ block: "nearest", inline: "nearest" });
        });
      });
    };
    revealActiveTabs();
    window.addEventListener("resize", revealActiveTabs);
    return () => {
      window.removeEventListener("resize", revealActiveTabs);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [activeTabsKey]);

  const liveThreadActivityKey = Object.values(sessions)
    .filter((session) => session.threadId)
    .map((session) => `${nativeSessionKey(session.provider, session.threadId || "")}:${session.updatedAt}`)
    .join("|");
  const liveThreadActivity = useMemo(() => {
    const next: Record<string, number> = {};
    for (const session of Object.values(sessions)) {
      if (session.threadId && session.updatedAt) next[nativeSessionKey(session.provider, session.threadId)] = session.updatedAt;
    }
    return next;
  }, [liveThreadActivityKey]);
  const contextPane = tabContextMenu ? layout.panes.find((pane) => pane.id === tabContextMenu.paneId) : undefined;
  const contextSession = tabContextMenu ? sessions[tabContextMenu.sessionId] : undefined;
  const contextHistoryEntry = contextSession?.threadId ? history.find((entry) => entry.provider === contextSession.provider && entry.id === contextSession.threadId) : undefined;
  const contextIndex = contextPane && tabContextMenu ? contextPane.tabIds.indexOf(tabContextMenu.sessionId) : -1;
  const contextOthers = contextPane && tabContextMenu ? contextPane.tabIds.filter((id) => id !== tabContextMenu.sessionId) : [];
  const contextLeft = contextPane && contextIndex >= 0 ? contextPane.tabIds.slice(0, contextIndex) : [];
  const contextRight = contextPane && contextIndex >= 0 ? contextPane.tabIds.slice(contextIndex + 1) : [];
  const sidebarActiveThreadId = activeSession?.threadId || null;
  const sidebarCurrentCwd = workspace || activeSession?.cwd || "";
  const sidebarDirectoryHistory = useMemo(() => {
    const key = normalizedDirectory(sidebarCurrentCwd);
    return key ? history.filter((entry) => entry.cwdKey === key) : [];
  }, [history, sidebarCurrentCwd]);
  const sidebarRecentHistory = useMemo(() => sortHistoryByRecency(history, liveThreadActivity), [history, liveThreadActivity]);
  const sidebarLayout = useMemo<SidebarProps["layout"]>(() => ({
    collapsed: sidebarCollapsed,
    onToggleCollapsed: toggleSidebarCollapsed,
    onResizeStart: startSidebarResize,
  }), [sidebarCollapsed, startSidebarResize, toggleSidebarCollapsed]);
  const sidebarToolbar = useMemo<SidebarProps["toolbar"]>(() => ({
    pluginMarketplaceState: providerCapabilities.codex.pluginMarketplace === "supported" || providerCapabilities.claude.pluginMarketplace === "supported" ? "supported" : "temporarilyUnavailable",
    splitDisabled: layout.panes.length >= 2,
    onChooseWorkspace: chooseWorkspace,
    onOpenPlugins: openPluginPanel,
    onSplitPane: () => splitPane(layout.activePaneId || "pane-1"),
  }), [chooseWorkspace, layout.activePaneId, layout.panes.length, openPluginPanel, providerCapabilities.claude.pluginMarketplace, providerCapabilities.codex.pluginMarketplace, splitPane]);
  const sidebarWorkspace = useMemo<SidebarProps["workspace"]>(() => ({
    viewModel: {
      currentCwd: sidebarCurrentCwd,
      activeCwd: sidebarCurrentCwd,
      currentDirectoryHistoryCount: sidebarDirectoryHistory.length,
      favoriteWorkspaces: preferences.favoriteWorkspaces,
    },
    actions: {
      onNewSession: (directory, provider) => { void createSessionInDirectory(directory, provider); },
      onSelectWorkspace: selectWorkspace,
      onToggleFavorite: toggleFavorite,
      onSavePreference: savePreference,
      onOpenTerminal: openWindowsTerminal,
      onOpenDirectory: openDirectoryInExplorer,
    },
  }), [createSessionInDirectory, openDirectoryInExplorer, openWindowsTerminal, preferences.favoriteWorkspaces, savePreference, selectWorkspace, sidebarCurrentCwd, sidebarDirectoryHistory.length, toggleFavorite]);
  const sidebarHistory = useMemo<SidebarProps["history"]>(() => ({
    viewModel: {
      activeCwd: sidebarCurrentCwd,
      directoryHistory: sidebarDirectoryHistory,
      favoriteHistory,
      recentHistory: sidebarRecentHistory,
      historyHasMore: Boolean(historyCursor),
      historyLoading,
      recentHasMore: Boolean(recentHistoryCursor),
      recentLoading: recentHistoryLoading,
      historySearchResults,
      historySearchLoading,
      historySearchHasMore: Boolean(historySearchCursor),
      liveThreadActivity,
      activeThreadId: sidebarActiveThreadId,
      activeProvider: activeSession?.provider || null,
      providerCapabilities,
    },
    actions: {
      onOpenHistory: (entry) => { void openHistory(entry); },
      onHistoryAction: runHistoryAction,
      isHistoryWorking,
      onLoadMoreHistory: loadMoreHistory,
      onLoadRecent: () => { void loadRecentHistory(); },
      onLoadMoreRecent: () => { void loadMoreRecentHistory(); },
      onSearchHistory: searchHistory,
      onLoadMoreHistorySearch: loadMoreHistorySearch,
    },
  }), [activeSession?.provider, favoriteHistory, historyCursor, historyLoading, historySearchCursor, historySearchLoading, historySearchResults, isHistoryWorking, liveThreadActivity, loadMoreHistory, loadMoreHistorySearch, loadMoreRecentHistory, loadRecentHistory, openHistory, providerCapabilities, recentHistoryCursor, recentHistoryLoading, runHistoryAction, searchHistory, sidebarActiveThreadId, sidebarCurrentCwd, sidebarDirectoryHistory, sidebarRecentHistory]);
  const sidebarSettings = useMemo<SidebarProps["settings"]>(() => ({
    viewModel: {
      theme: preferences.theme,
      baseFontSize,
      displayMode,
      updateStatus,
      cliUpdateStatus,
      claudeStatus: claudeRuntimeStatus,
      bossKeyStatus,
    },
    actions: {
      onSavePreference: savePreference,
      onSetBossKey: setBossKey,
      onCheckForUpdates: checkForUpdates,
      onCheckCodexCliUpdates: checkCodexCliUpdates,
      onUpdateCodexCli: updateCodexCli,
      onCheckClaude: checkClaudeCodeUpdates,
      onUpdateClaude: updateClaudeCode,
      onDownloadUpdate: downloadUpdate,
      onInstallUpdate: installUpdate,
      onOpenUpdateRepository: openUpdateRepository,
      onExportDiagnostics: bridge.exportDiagnostics,
    },
  }), [baseFontSize, bossKeyStatus, bridge.exportDiagnostics, checkClaudeCodeUpdates, checkCodexCliUpdates, checkForUpdates, claudeRuntimeStatus, cliUpdateStatus, displayMode, downloadUpdate, installUpdate, openUpdateRepository, preferences.theme, savePreference, setBossKey, updateClaudeCode, updateCodexCli, updateStatus]);

  const renderPane = (pane: PaneState) => {
    const session = sessions[pane.activeTabId];
    if (!session) return null;
    return (
      <PaneView
        key={pane.id}
        pane={pane}
        session={session}
        isActivePane={pane.id === layout.activePaneId}
        models={providerModels[session.provider]}
        skills={skillsByCwd[providerDirectoryKey(session.provider, session.cwd)] ?? NO_SKILLS}
        recentCommandUsage={recentCommandUsage}
        attachments={attachments[session.id] ?? NO_ATTACHMENTS}
        queuedMessages={queuedMessages[session.id] ?? NO_QUEUED_MESSAGES}
        pendingSteers={pendingSteers[session.id] ?? NO_PENDING_STEERS}
        draftRevision={draftRevisions[session.id] || 0}
        displayMode={displayMode}
        bridge={bridge}
        onFocusPane={focusPane}
        onMoveTab={moveTab}
        onSetSessionSetting={setSessionSetting}
        onSetCollaborationMode={setCollaborationMode}
        onCompact={compactSession}
        onToggleDetails={toggleDetails}
        onSetDetailView={setDetailView}
        onStartGoal={startGoal}
        onStopGoal={stopGoal}
        onClearError={clearError}
        onRetryReadOnly={retryReadOnlySession}
        onRespondApproval={respondToApproval}
        onInterrupt={interrupt}
        getDraft={getDraft}
        onDraftChange={onDraftChange}
        onSend={sendMessage}
        onCycleEffort={cycleEffort}
        onAddImages={addImages}
        onRemoveImage={removeImage}
        onRemoveQueuedMessage={removeQueuedMessage}
        onChooseDirectory={chooseDirectoryForSession}
      />
    );
  };

  return <div className="window-shell">
    <WindowTitleBar bridge={bridge} />
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} data-pane-count={layout.panes.length} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    <Sidebar layout={sidebarLayout} toolbar={sidebarToolbar} workspace={sidebarWorkspace} history={sidebarHistory} settings={sidebarSettings} />
    <div className="workspace-area">
      <div className="tabbar">
        <div className="pane-tab-groups">
          {layout.panes.map((pane) => <div
            className={`pane-tab-group ${pane.id === layout.activePaneId ? "active" : ""} ${layout.panes.length > 1 ? "has-pane-close" : ""} ${tabDropPaneId === pane.id && draggingTabId ? "drop-target" : ""}`}
            key={pane.id}
            onDragEnter={(event: DragEvent<HTMLDivElement>) => {
              if (!event.dataTransfer.types.includes("text/tab")) return;
              event.preventDefault();
              setTabDropPaneId(pane.id);
              setTabDropTarget(null);
            }}
            onDragOver={(event: DragEvent<HTMLDivElement>) => {
              if (!event.dataTransfer.types.includes("text/tab")) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setTabDropPaneId(pane.id);
            }}
            onDragLeave={(event: DragEvent<HTMLDivElement>) => {
              const nextTarget = event.relatedTarget as Node | null;
              if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                setTabDropPaneId(null);
                setTabDropTarget(null);
              }
            }}
            onDrop={(event: DragEvent<HTMLDivElement>) => {
              event.preventDefault();
              event.stopPropagation();
              const sessionId = event.dataTransfer.getData("text/tab");
              setTabDropPaneId(null);
              setTabDropTarget(null);
              setDraggingTabId(null);
              if (sessionId) {
                trackUiEvent("tab.drag_dropped", { provider: sessions[sessionId]?.provider || "unknown", position: "pane" });
                moveTab(sessionId, pane.id);
              }
            }}
          >
            <div className="tab-list">
              {pane.tabIds.map((id) => sessions[id]).filter(Boolean).map((session) => (
                <button
                  className={`tab ${session.id === pane.activeTabId ? "active" : ""} ${draggingTabId === session.id ? "dragging" : ""} ${tabDropTarget?.paneId === pane.id && tabDropTarget.sessionId === session.id ? `drop-${tabDropTarget.position}` : ""}`}
                  data-session-id={session.id}
                  draggable
                  title={`${session.title}\n${session.cwd}`}
                  onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/tab", session.id);
                    setDraggingTabId(session.id);
                    trackUiEvent("tab.drag_started", { provider: session.provider });
                  }}
                  onDragOver={(event: DragEvent<HTMLButtonElement>) => {
                    if (!event.dataTransfer.types.includes("text/tab")) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (!draggingTabId || draggingTabId === session.id) {
                      setTabDropTarget(null);
                      return;
                    }
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const position: TabDropPosition = event.clientX < bounds.left + bounds.width / 2 ? "before" : "after";
                    setTabDropPaneId(pane.id);
                    setTabDropTarget({ paneId: pane.id, sessionId: session.id, position });
                  }}
                  onDragLeave={(event: DragEvent<HTMLButtonElement>) => {
                    const nextTarget = event.relatedTarget as Node | null;
                    if (!nextTarget || !event.currentTarget.contains(nextTarget)) setTabDropTarget(null);
                  }}
                  onDrop={(event: DragEvent<HTMLButtonElement>) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const draggedId = event.dataTransfer.getData("text/tab");
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const position: TabDropPosition = event.clientX < bounds.left + bounds.width / 2 ? "before" : "after";
                    setDraggingTabId(null);
                    setTabDropPaneId(null);
                    setTabDropTarget(null);
                    if (draggedId && draggedId !== session.id) {
                      trackUiEvent("tab.drag_dropped", { provider: sessions[draggedId]?.provider || "unknown", position });
                      moveTab(draggedId, pane.id, { paneId: pane.id, sessionId: session.id, position });
                    }
                  }}
                  onDragEnd={() => { trackUiEvent("tab.drag_finished", { provider: session.provider }); setDraggingTabId(null); setTabDropPaneId(null); setTabDropTarget(null); }}
                  onClick={() => activateTab(pane.id, session.id)}
                  onContextMenu={(event) => openTabContextMenu(event, pane.id, session.id)}
                  key={session.id}
                >
                  <ProviderIcon provider={session.provider} size={15} /><span className={`tab-status ${session.status}`} />
                  <span className="tab-label"><span className="tab-directory">{basename(session.cwd)}</span><span className="tab-separator">·</span><span className="tab-title">{session.title}</span></span>
                  {pane.tabIds.length > 1
                    ? <span className="tab-close" role="button" aria-label={`关闭 ${session.title}`} title={`关闭 ${session.title}`} onClick={(event) => { event.stopPropagation(); removeTab(pane.id, session.id); }}><X size={12} /></span>
                    : null}
                </button>
              ))}
            </div>
            {layout.panes.length > 1 ? <button className="pane-tab-close" onClick={() => closePane(pane.id)} title="关闭此分栏" aria-label="关闭此分栏"><X size={14} /></button> : null}
          </div>)}
        </div>
      </div>
      <div className="panes-grid" style={{ gridTemplateColumns: layout.panes.length === 2 ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)" }}>
        {layout.panes.map(renderPane)}
      </div>
    </div>
    {pluginPanelOpen ? <Suspense fallback={<div className="plugin-overlay" role="dialog" aria-modal="true" aria-label="正在打开插件市场"><section className="plugin-panel lazy-panel-loading">正在打开插件市场</section></div>}><PluginPanel cwd={activeSession?.cwd || workspace} initialProvider={activeSession?.provider || "codex"} request={requestForPluginPanel} chooseClaudeMarketplaceDirectory={bridge.chooseClaudeMarketplaceDirectory} onClose={closePluginPanel} /></Suspense> : null}
    {tabContextMenu && contextPane ? <div
      className="tab-context-menu"
      role="menu"
      aria-label={`${contextSession?.title || "当前 Tab"} 会话操作`}
      style={{ left: Math.min(tabContextMenu.x, Math.max(8, window.innerWidth - 190)), top: Math.min(tabContextMenu.y, Math.max(8, window.innerHeight - 478)) }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button type="button" role="menuitem" disabled={!contextSession} onClick={() => { if (!contextSession) return; setTabContextMenu(null); void createSessionInDirectory(contextSession.cwd, contextSession.provider, { paneId: contextPane.id, afterSessionId: contextSession.id }); }}><Plus size={14} /><span>新建同目录会话</span></button>
      <button type="button" role="menuitem" disabled={!contextSession} onClick={() => { if (!contextSession) return; setTabContextMenu(null); openDirectoryInExplorer(contextSession.cwd, contextSession.id); }}><FolderOpen size={14} /><span>在资源管理器中打开目录</span></button>
      <div className="context-menu-separator" />
      <button type="button" role="menuitem" disabled={!contextOthers.length} onClick={() => closeTabIds(contextPane.id, contextOthers)}><X size={14} /><span>关闭其它</span></button>
      <button type="button" role="menuitem" disabled={!contextRight.length} onClick={() => closeTabIds(contextPane.id, contextRight)}><ArrowRightToLine size={14} /><span>关闭右侧</span></button>
      <button type="button" role="menuitem" disabled={!contextLeft.length} onClick={() => closeTabIds(contextPane.id, contextLeft)}><ArrowLeftToLine size={14} /><span>关闭左侧</span></button>
      <div className="context-menu-separator" />
      {contextSession?.capabilities.rename !== "unsupported" ? <button type="button" role="menuitem" disabled={!contextSession || contextSession.capabilities.rename !== "supported"} onClick={() => { if (!contextSession) return; setTabContextMenu(null); setTabRenameName(contextSession.title); setTabRenameTarget({ sessionId: contextSession.id, title: contextSession.title }); }}><Pencil size={14} /><span>重命名</span></button> : null}
      {contextSession?.capabilities.pin !== "unsupported" ? <button type="button" role="menuitem" disabled={!contextSession || contextSession.capabilities.pin !== "supported"} onClick={() => { if (!contextSession) return; void toggleThreadPin(contextSession.id); }}>{contextHistoryEntry?.isPinned ? <PinOff size={14} /> : <Pin size={14} />}<span>{contextHistoryEntry?.isPinned ? "取消置顶" : "置顶"}</span></button> : null}
      <button type="button" role="menuitem" disabled={!contextSession} onClick={() => { if (!contextSession) return; void toggleSessionFavorite(contextSession.id); }}><Star size={14} fill={contextHistoryEntry?.isFavorite ? "currentColor" : "none"} /><span>{contextHistoryEntry?.isFavorite ? "取消收藏" : "收藏"}</span></button>
      <button type="button" role="menuitem" disabled={!contextSession} onClick={() => { if (!contextSession) return; setTabContextMenu(null); void exportSession(contextSession.id); }}><Download size={14} /><span>导出 Markdown</span></button>
      <button type="button" role="menuitem" disabled={!contextSession} onClick={() => { if (!contextSession) return; void handoffSession(contextSession.id, "codex"); }}><ArrowRight size={14} /><span>交接到 Codex</span></button>
      <button type="button" role="menuitem" disabled={!contextSession} onClick={() => { if (!contextSession) return; void handoffSession(contextSession.id, "claude"); }}><ArrowRight size={14} /><span>交接到 Claude Code</span></button>
      {contextSession?.capabilities.fork !== "unsupported" ? <button type="button" role="menuitem" disabled={!contextSession || contextSession.status === "working" || contextSession.capabilities.fork !== "supported"} onClick={() => { if (!contextSession) return; void forkSession(contextSession.id); }}><GitFork size={14} /><span>创建分支</span></button> : null}
      {contextSession?.capabilities.delete !== "unsupported" ? <button className="danger" type="button" role="menuitem" disabled={!contextSession || sessionHasActiveWork(contextSession) || contextSession.capabilities.delete !== "supported"} onClick={() => { if (!contextSession) return; void deleteSession(contextSession.id); }}><Trash2 size={14} /><span>永久删除本机会话</span></button> : null}
    </div> : null}
    {tabRenameTarget ? <div className="dialog-backdrop" onMouseDown={() => setTabRenameTarget(null)}>
      <form className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="tab-rename-dialog-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); const name = tabRenameName.trim(); if (!name) return; const target = tabRenameTarget; setTabRenameTarget(null); void renameSession(target.sessionId, name); }}>
        <strong id="tab-rename-dialog-title">重命名会话</strong>
        <input autoFocus value={tabRenameName} onChange={(event) => setTabRenameName(event.target.value)} aria-label="会话名称" maxLength={200} />
        <div className="rename-dialog-actions">
          <button type="button" onClick={() => setTabRenameTarget(null)}>取消</button>
          <button type="submit" className="primary" disabled={!tabRenameName.trim() || tabRenameName.trim() === tabRenameTarget.title}>保存</button>
        </div>
      </form>
    </div> : null}
    </div>
  </div>;
}
