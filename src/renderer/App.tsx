import { ArrowLeftToLine, ArrowRight, ArrowRightToLine, Columns2, Download, GitFork, Pencil, Pin, PinOff, Star, Trash2, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { AgentCapabilities, AgentOperation, AgentProvider } from "../shared/agentProtocol";
import { DEFAULT_BOSS_KEY } from "../shared/bossKey";
import { providerDisplayName } from "../shared/providerMetadata";
import { DEFAULT_BASE_FONT_SIZE, type AgentBridge, type BossKeyStatus, type ClaudeRuntimeStatus, type CodexCliUpdateStatus, type CodexDefaults, type DesktopPreferences, type DesktopUpdateStatus, type JsonObject } from "../shared/protocol";
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
import { codexRequestMethod, isCodexRequestTimeout, mergeMessages } from "./inputQueue";
import {
  applyProviderModelDefaults, initialProviderCapabilities, initialProviderModels, newSessionDefaults, normalizeAgentRequestError, providerAffectsStartupState,
  providerDisconnectedMessage, trustWorkspaceForRequest, workspaceForProvider,
} from "./agent/providerRegistry";
import { createMockAgentBridge } from "./mockBridge";
import PaneView from "./PaneView";
import { appendRawEvent, clearRawEvents } from "./rawEventStore";
import Sidebar, { type HistoryAction, type SidebarProps } from "./Sidebar";
import { handoffMarkdown, sessionMarkdown } from "./sessionTools";
import { createUpdateWorkspaceState, loadSavedImages, parseUpdateWorkspaceState } from "./workspaceState";
import { SessionSettingsCoordinator } from "./sessionSettingsCoordinator";
import { recoverProviderSessions } from "./providerRecovery";
import { SessionLifecycleController } from "./sessionLifecycleController";
import { SessionMessageController } from "./sessionMessageController";
import { nativeSessionKey, ProviderEventController } from "./providerEventController";
import { applyLocalSessionMetadata, favoriteHistoryEntries, favoriteSessionSummary, HistoryController, isFavoriteSession, mergeHistory, sortHistory } from "./historyController";
import { LayoutController, type TabDropPosition, type TabDropTarget } from "./layoutController";
import WindowTitleBar from "./WindowTitleBar";
import ProviderIcon from "./ProviderIcon";
import { closeSessionResources } from "./sessionLifecycle";

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
const INITIAL_UPDATE_STATUS: DesktopUpdateStatus = { phase: "idle", currentVersion: "", message: "仅在手动检查时连接 GitHub。", tokenConfigured: false, repositoryUrl: "https://github.com/yxb715/agentdesk" };
const INITIAL_CLI_UPDATE_STATUS: CodexCliUpdateStatus = { phase: "idle", currentVersion: "", message: "正在读取 Codex CLI 版本。" };
const INITIAL_CLAUDE_RUNTIME_STATUS: ClaudeRuntimeStatus = { phase: "idle", binarySource: "sdk", binaryVersion: "", sdkVersion: "", credentialsAvailable: false, credentialSource: "unavailable", credentialMessage: "正在读取 Claude 配置。", trustedWorkspaces: [], message: "仅在手动检查时连接 Claude Code 发布源。" };
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

function subagentThreadSource(threadValue: unknown) {
  const thread = asRecord(threadValue);
  const subagent = asRecord(asRecord(thread.source).subAgent);
  const spawn = asRecord(subagent.thread_spawn);
  return {
    parentThreadId: stringValue(thread.parentThreadId) || stringValue(spawn.parent_thread_id),
    nickname: stringValue(thread.agentNickname) || stringValue(spawn.agent_nickname),
    role: stringValue(thread.agentRole) || stringValue(spawn.agent_role),
  };
}

export default function App() {
  const bridge = useAgentBridge();
  const agentClient = useMemo(() => new AgentClient(bridge), [bridge]);
  const [workspace, setWorkspace] = useState("正在连接工作区");
  const [sessions, setSessions] = useState<Record<string, SessionState>>({});
  const [layout, setLayout] = useState<LayoutState>({ panes: [{ id: "pane-1", tabIds: ["session-1"], activeTabId: "session-1" }], activePaneId: "pane-1" });
  const [history, setHistory] = useState<HistoryThread[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySearchResults, setHistorySearchResults] = useState<HistoryThread[] | null>(null);
  const [historySearchLoading, setHistorySearchLoading] = useState(false);
  const [historySearchCursor, setHistorySearchCursor] = useState<string | null>(null);
  const [providerModels, setProviderModels] = useState<Record<AgentProvider, ModelOption[]>>(() => initialProviderModels());
  const [providerCapabilities, setProviderCapabilities] = useState<Record<AgentProvider, AgentCapabilities>>(() => initialProviderCapabilities());
  const [skillsByCwd, setSkillsByCwd] = useState<Record<string, SkillOption[]>>({});
  const [codexDefaults, setCodexDefaults] = useState<CodexDefaults>(EMPTY_CODEX_DEFAULTS);
  const [serverState, setServerState] = useState<"connecting" | "ready" | "error">("connecting");
  const [preferences, setPreferences] = useState<DesktopPreferences>({ recentWorkspaces: [], lastWorkspace: "", favoriteWorkspaces: [], theme: DEFAULT_THEME, displayMode: DEFAULT_DISPLAY_MODE, bossKey: DEFAULT_BOSS_KEY });
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
  const claudeRuntimeStatusRef = useRef(claudeRuntimeStatus);
  const tabContextMenuRef = useRef(tabContextMenu);
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
  claudeRuntimeStatusRef.current = claudeRuntimeStatus;
  tabContextMenuRef.current = tabContextMenu;

  const draftsRef = useRef(new Map<string, string>());
  const skillLoadsRef = useRef(new Map<string, Promise<void>>());
  const workspaceRestoreIdsRef = useRef(new Set<string>());
  const sessionLifecycleRef = useRef(new SessionLifecycleController());
  const sessionMessageRef = useRef<SessionMessageController | null>(null);
  const providerEventRef = useRef<ProviderEventController | null>(null);
  const historyControllerRef = useRef<HistoryController | null>(null);
  const layoutControllerRef = useRef<LayoutController | null>(null);
  const settingsCoordinatorRef = useRef(new SessionSettingsCoordinator());
  const workspaceRestoreInProgressRef = useRef(false);

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
    updateSession(sessionId, (current) => ({ ...current, errorText: error instanceof Error ? error.message : fallback }));
  }, [updateSession]);

  /**
   * 会话相关请求都走这里：响应和错误直接记入原始事件存储。
   * 这替代了原先主进程额外发一遍 client/routed-response 的做法，审计信息不变，IPC 少一次。
   */
  const requestForSession = useCallback(async (sessionId: string, operation: AgentOperation, params: JsonObject) => {
    const session = sessionsRef.current[sessionId];
    const provider = session?.provider || "codex";
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
      const canonicalCwd = trustWorkspaceForRequest(provider, operation, normalized, session?.cwd);
      if (canonicalCwd) {
        const accepted = window.confirm(`Claude Code 将在以下目录运行：\n\n${canonicalCwd}\n\n项目配置可能启动 Hooks、MCP 或插件进程。仅在你信任此目录内容时继续。`);
        if (!accepted) throw new Error("已取消 Claude Code 工作区授权。");
        const value = await agentClient.request(provider, operation, { ...params, trustWorkspace: true }, context);
        appendRawEvent(sessionId, `response ${operation}`, { provider, payload: value });
        return value;
      }
      appendRawEvent(sessionId, `error ${operation}`, { provider, message: normalized.message, ...(normalized instanceof Error && "payload" in normalized ? { payload: (normalized as { payload: unknown }).payload } : {}) });
      throw normalized;
    }
  }, [agentClient]);

  const requestForPluginPanel = useCallback((operation: AgentOperation, params: JsonObject) => {
    const pane = layoutRef.current.panes.find((entry) => entry.id === layoutRef.current.activePaneId) || layoutRef.current.panes[0];
    const sessionId = pane?.activeTabId || Object.keys(sessionsRef.current)[0];
    return sessionId ? requestForSession(sessionId, operation, params) : agentClient.request("codex", operation, params);
  }, [agentClient, requestForSession]);

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
    const defaults = newSessionDefaults(provider, providerModelsRef.current[provider], defaultsRef.current, providerCapabilitiesRef.current[provider]);
    const session = emptySession(id, cwd, defaults.model, defaults.effort, provider);
    session.capabilities = defaults.capabilities;
    session.tokenUsage.total = cachedModelContextWindow(preferencesRef.current, session.model);
    session.threadId = options?.threadId ?? null;
    session.title = options?.title || "新会话";
    session.resumed = false;
    sessionsRef.current = { ...sessionsRef.current, [id]: session };
    setSessions((current) => ({ ...current, [id]: session }));
    return id;
  }, []);

  const toggleSidebarCollapsed = useCallback(() => {
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
      interrupt: async () => {
        await agentClient.request(session.provider, "interruptTurn", { threadId: session.threadId || "", turnId: session.activeTurnId || "" }, context);
      },
      waitForIdle: () => waitForSessionIdle(sessionId),
      close: async () => {
        await agentClient.request(session.provider, "closeSession", {}, context);
      },
    }).then((result) => {
      const error = result.closeError ?? result.interruptError;
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
    addSession, activateSession, focusPane, setActiveTab, removeTab, closeTabIds,
    splitPane, closePane, closeActiveTab, moveTab,
  } = layoutController;

  const openTabContextMenu = useCallback((event: MouseEvent<HTMLButtonElement>, paneId: string, sessionId: string) => {
    event.preventDefault();
    setTabContextMenu({ paneId, sessionId, x: event.clientX, y: event.clientY });
  }, []);

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
    const next = await bridge.savePreferences(patch);
    setPreferences((current) => ({ ...current, ...next }));
    setHistory((current) => applyLocalSessionMetadata(current, next));
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
    const tokens = asRecord(payload.tokenUsage).modelContextWindow;
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
    let nextWidth = sidebarWidthFromPointer(event.clientX);
    setSidebarWidth(nextWidth);
    document.body.classList.add("resizing-sidebar");

    const resize = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      nextWidth = sidebarWidthFromPointer(pointerEvent.clientX);
      setSidebarWidth(nextWidth);
    };
    const finish = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove("resizing-sidebar");
      void savePreference({ sidebarWidth: nextWidth }).catch(() => undefined);
    };

    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }, [savePreference]);

  const saveUpdateToken = useCallback(async (token: string) => {
    setUpdateStatus(await bridge.saveUpdateToken(token));
  }, [bridge]);

  const clearUpdateToken = useCallback(async () => {
    setUpdateStatus(await bridge.clearUpdateToken());
  }, [bridge]);

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
    if (!window.confirm("更新 Claude Code 会停止全部 Claude 会话、Query、Worker 和后代进程，Codex 会话不会停止。确定继续吗？")) return;
    let status = await bridge.updateClaudeCode(false);
    if (!status.integrityVerified && status.phase === "available") {
      const signer = status.integritySigner || "未检测到签名者";
      if (!window.confirm(`无法验证 Claude 发布方完整性。\n\n签名者：${signer}\n\n只有你确认继续承担风险后才会安装，是否继续？`)) return;
      status = await bridge.updateClaudeCode(true);
    }
    setClaudeRuntimeStatus(status);
  }, [bridge]);
  const revokeClaudeWorkspace = useCallback(async (cwd: string) => {
    setClaudeRuntimeStatus(await bridge.revokeClaudeWorkspace(cwd));
  }, [bridge]);

  const downloadUpdate = useCallback(async () => {
    setUpdateStatus(await bridge.downloadUpdate());
  }, [bridge]);

  const installUpdate = useCallback(async () => {
    if (workspaceRestoreInProgressRef.current) throw new Error("本地会话仍在恢复，请稍后再重启安装。");
    const workspaceState = createUpdateWorkspaceState({
      workspace,
      layout: layoutRef.current,
      sessions: sessionsRef.current,
      drafts: draftsRef.current,
      attachments: attachmentsRef.current,
      queuedMessages: queuedMessagesRef.current,
      pendingSteers: pendingSteersRef.current,
      sidebarCollapsed,
    });
    await bridge.savePreferences({ workspaceState });
    await bridge.installUpdate();
  }, [bridge, sidebarCollapsed, workspace]);
  const openUpdateTokenPage = useCallback(() => bridge.openExternal("https://github.com/settings/personal-access-tokens/new"), [bridge]);

  const selectWorkspace = useCallback(async (directory: string) => {
    setWorkspace(directory);
    const currentLayout = layoutRef.current;
    const pane = currentLayout.panes.find((entry) => entry.id === currentLayout.activePaneId) ?? currentLayout.panes[0];
    const session = pane ? sessionsRef.current[pane.activeTabId] : undefined;
    const canRetarget = Boolean(
      session
      && !session.threadId
      && !session.messages.length
      && !session.activities.length
      && session.status === "idle"
      && !(attachmentsRef.current[session.id] || []).length
      && !draftsRef.current.get(session.id),
    );
    if (session && canRetarget && !sameDirectory(session.cwd, directory)) {
      updateSession(session.id, (current) => ({ ...current, cwd: directory, updatedAt: Date.now() }));
    } else if (!session || !sameDirectory(session.cwd, directory)) {
      // 已有 Thread 的工作目录不可修改，切换目录时打开新的空 Tab。
      addSession(directory);
    }
    await savePreference({ lastWorkspace: directory, recentWorkspaces: [] });
  }, [addSession, savePreference, updateSession]);

  const createSessionInDirectory = useCallback((directory: string, provider: AgentProvider = "codex") => {
    setWorkspace(directory);
    const sessionId = addSession(directory, { provider });
    void agentClient.request(provider, "getCapabilities", {}, { sessionId, canonicalCwd: directory })
      .then((value) => {
        const capabilities = value as SessionState["capabilities"];
        updateSession(sessionId, (current) => ({ ...current, capabilities }));
      })
      .catch((error) => setError(sessionId, error, "读取 Provider 能力失败"));
    void savePreference({ lastWorkspace: directory, recentWorkspaces: [] });
    return sessionId;
  }, [addSession, agentClient, savePreference, setError, updateSession]);

  useEffect(() => {
    const handleNewSessionShortcut = (event: KeyboardEvent) => {
      if (event.altKey || (!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== "n") return;
      event.preventDefault();
      const provider: AgentProvider = event.shiftKey ? "claude" : "codex";
      createSessionInDirectory(activeSession?.cwd || workspace, provider);
    };
    window.addEventListener("keydown", handleNewSessionShortcut);
    return () => window.removeEventListener("keydown", handleNewSessionShortcut);
  }, [activeSession?.cwd, createSessionInDirectory, workspace]);

  const chooseWorkspace = useCallback(async () => {
    const next = await bridge.chooseWorkspace(workspace);
    if (next) await selectWorkspace(next);
  }, [bridge, selectWorkspace, workspace]);

  const chooseDirectoryForSession = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    if (!session || session.threadId) return;
    const next = await bridge.chooseWorkspace(session.cwd || workspace);
    if (!next) return;
    setWorkspace(next);
    await savePreference({ lastWorkspace: next, recentWorkspaces: [] });
    updateSession(sessionId, (current) => (current.threadId ? current : { ...current, cwd: next, updatedAt: Date.now() }));
  }, [bridge, savePreference, updateSession, workspace]);

  const openWindowsTerminal = useCallback((cwd: string) => {
    void bridge.openWindowsTerminal(cwd).catch((error) => {
      const pane = layoutRef.current.panes.find((entry) => entry.id === layoutRef.current.activePaneId);
      const sessionId = pane?.activeTabId;
      if (sessionId) setError(sessionId, error, "打开 Windows Terminal 失败");
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
    const availableModels = providerModelsRef.current[session.provider];
    const selectedModel = field === "model" ? findModelOption(availableModels, value) : findModelOption(availableModels, currentTarget.model);
    const nextEffort = field === "model" && selectedModel && !selectedModel.efforts.includes(currentTarget.effort)
      ? selectedModel.defaultEffort
      : field === "effort" ? value : currentTarget.effort || selectedModel?.defaultEffort || "medium";
    const requested = { model: field === "model" ? value : selectedModel?.id || currentTarget.model, effort: nextEffort };
    updateSession(sessionId, (current) => {
      return { ...current, model: requested.model, effort: requested.effort, tokenUsage: tokenUsageForModel(current, requested.model, preferencesRef.current) };
    });
    if (!session.threadId) {
      settingsCoordinatorRef.current.setConfirmed(sessionId, requested);
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
  }, [requestForSession, updateSession]);

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
      updateSession(sessionId, (current) => ({ ...current, title: name, updatedAt: Date.now() }));
      if (session.threadId) setHistory((current) => sortHistory(current.map((entry) => entry.provider === session.provider && entry.id === session.threadId ? { ...entry, title: name, titleLower: name.toLowerCase() } : entry)));
    } catch (error) {
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
        model: stringValue(result.model, session.model),
        effort: stringValue(result.reasoningEffort, session.effort),
        resumed: false,
        tokenUsage: tokenUsageForModel(current, stringValue(result.model, session.model), preferencesRef.current),
      }));
      setHistory((current) => upsertHistoryEntry(current, { id: threadId, provider: session.provider, title, cwd }));
      void requestForSession(forkedSessionId, "renameSession", { threadId, name: title }).catch((error) => setError(forkedSessionId, error, "分支重命名失败"));
    } catch (error) {
      setError(sessionId, error, "创建分支失败");
    }
  }, [addSession, requestForSession, setError, updateSession]);

  const deleteSession = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current[sessionId];
    setTabContextMenu(null);
    if (!session?.threadId) {
      if (session) setError(sessionId, new Error("当前会话还没有保存到本机历史。"), "当前会话还没有保存到本机历史。");
      return;
    }
    const providerTitle = providerDisplayName(session.provider);
    const title = session.title || `${providerTitle} 会话`;
    const runningNotice = session.status === "working" || session.pendingApprovals.length
      ? "\n\n当前任务会先停止，待处理请求会被取消。"
      : "";
    if (!window.confirm(`确认永久删除这条会话？\n\n${title}\n\n这会从本机 ${providerTitle} 历史中删除会话内容，不可恢复。${runningNotice}`)) return;
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
      await savePreference({
        sessionAliases: aliases,
        favoriteSessions: (preferencesRef.current.favoriteSessions || []).filter((id) => id !== key && id !== threadId),
        favoriteSessionSummaries,
      });
      setHistory((current) => current.filter((entry) => entry.provider !== session.provider || entry.id !== threadId));
      await clearSession(sessionId);
    } catch (error) {
      setError(sessionId, error, "删除会话失败");
    }
  }, [clearSession, requestForSession, savePreference, setError]);

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
      const nextSessionId = createSessionInDirectory(session.cwd, targetProvider);
      updateSession(nextSessionId, (current) => ({ ...current, title: `${session.title || "新会话"} 接力` }));
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
      setSearchResults: (entries, merge) => setHistorySearchResults((current) => merge ? mergeHistory(current || [], entries || []) : entries),
      setSearchLoading: setHistorySearchLoading,
      setSearchCursor: setHistorySearchCursor,
    }, {
      request: (provider, operation, params) => agentClient.request(provider, operation, params),
      getPreferences: () => preferencesRef.current,
      isVisible: () => document.visibilityState !== "hidden",
    });
  }
  const historyController = historyControllerRef.current;
  const { refresh: refreshHistory, loadMore: loadMoreHistory, search: searchHistory, loadMoreSearch: loadMoreHistorySearch } = historyController;

  const openHistory = useCallback(async (entry: HistoryThread) => {
    const existing = Object.values(sessionsRef.current).find((session) => session.provider === entry.provider && session.threadId === entry.id && sameDirectory(session.cwd, entry.cwd));
    if (existing) {
      activateSession(existing.id);
      return existing.id;
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
    const sessionId = canReusePlaceholder && placeholder ? placeholder.id : addSession(entry.cwd, { threadId: entry.id, title: entry.title, provider: entry.provider });
    if (canReusePlaceholder) {
      updateSession(sessionId, (current) => ({
        ...current,
        provider: entry.provider,
        threadId: entry.id,
        cwd: entry.cwd,
        title: entry.title,
        resumed: false,
        errorText: "",
      }));
    }
    providerEventRef.current?.bindSession(entry.provider, entry.id, sessionId);

    // read 先到就先显示，不再等较慢的 resume；resume 独立完成后只补模型和思考等级。
    // 守卫在 resume 结束后清掉：失败时 resumed 仍为 false，下次发送会重新 resume 而不是永久报同一个错。
    const resumePromise = sessionLifecycleRef.current.resume(sessionId, () => (
      requestForSession(sessionId, "resumeSession", { threadId: entry.id, cwd: entry.cwd })
    ));

    const readVersion = providerEventRef.current?.captureVersion(sessionId) || { event: 0, lifecycle: 0 };
    const readPromise = requestForSession(sessionId, "readSession", { threadId: entry.id, includeTurns: true })
      .then((readValue) => {
        const preserve = providerEventRef.current?.changedSince(sessionId, readVersion) || { preserveRealtime: false, preserveLifecycle: false };
        updateSession(sessionId, (current) => hydrateAgentSession(current, current.provider, asRecord(readValue).thread, preserve));
      })
      .catch((error) => setError(sessionId, error, "读取历史会话失败"));

    try {
      const resume = asRecord(await resumePromise);
      updateSession(sessionId, (current) => {
        const model = stringValue(resume.model, current.model);
        return { ...current, model, effort: stringValue(resume.reasoningEffort, current.effort), resumed: true, tokenUsage: tokenUsageForModel(current, model, preferencesRef.current) };
      });
    } catch (error) {
      setError(sessionId, error, "恢复历史会话失败");
    }
    await readPromise;
    return sessionId;
  }, [activateSession, addSession, requestForSession, setError, updateSession]);

  const isHistoryWorking = useCallback((threadId: string, provider?: AgentProvider) => (
    Object.values(sessionsRef.current).some((session) => session.threadId === threadId && (!provider || session.provider === provider) && session.status === "working")
  ), []);

  const runHistoryAction = useCallback(async (entry: HistoryThread, action: HistoryAction, value?: string) => {
    const sessionId = await openHistory(entry);
    if (!sessionId) return;
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    if (action === "rename" && value) await renameSession(sessionId, value);
    else if (action === "pin") await toggleThreadPin(sessionId);
    else if (action === "favorite") await toggleSessionFavorite(sessionId);
    else if (action === "export") await exportSession(sessionId);
    else if (action === "handoffCodex") await handoffSession(sessionId, "codex");
    else if (action === "handoffClaude") await handoffSession(sessionId, "claude");
    else if (action === "fork") await forkSession(sessionId);
    else if (action === "delete") await deleteSession(sessionId);
  }, [deleteSession, exportSession, forkSession, handoffSession, openHistory, renameSession, toggleSessionFavorite, toggleThreadPin]);

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
  }, []);

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
    setSessions((current) => recoverProviderSessions(current, provider));
    if (providerAffectsStartupState(provider)) setServerState("error");
  }, [sessionMessages]);

  const reloadProviderSkills = useCallback(() => {
    skillsByCwdRef.current = {};
    setSkillsByCwd({});
    const requested = new Set<string>();
    for (const session of Object.values(sessionsRef.current)) {
      const key = providerDirectoryKey(session.provider, session.cwd);
      if (!normalizedDirectory(session.cwd) || requested.has(key) || session.capabilities.skills !== "supported") continue;
      requested.add(key);
      const pending = skillLoadsRef.current.get(key) || Promise.resolve();
      void pending.finally(() => loadSkills(session.id, session.cwd, true));
    }
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
        setReady: () => setServerState("ready"),
        removeHistory: (provider, nativeSessionId) => setHistory((current) => current.filter((entry) => entry.provider !== provider || entry.id !== nativeSessionId)),
        clearSession: (sessionId) => { void clearSession(sessionId); },
        recoverProvider,
        closeActiveTab: () => { void closeActiveTab(); },
        reloadSkills: reloadProviderSkills,
        activateSession,
        openWorkspace: (nextWorkspace) => { setWorkspace(nextWorkspace); addSession(nextWorkspace); },
        adoptStartedThread,
        loadSkills: (sessionId, cwd, forceReload) => { void loadSkills(sessionId, cwd, forceReload); },
        updateProviderModels: (provider, models) => {
          setProviderModels((current) => ({ ...current, [provider]: models }));
          if (provider === "claude") updateClaudeModelCache(models);
        },
        rememberModelContextWindow,
        appendRawEvent,
        showNotification: (session) => { void bridge.showNotification({ sessionId: session.id, provider: session.provider, sessionTitle: session.title }); },
        isDocumentFocused: () => document.hasFocus(),
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (handle) => window.cancelAnimationFrame(handle),
      },
    });
  }
  const providerEvents = providerEventRef.current;

  useEffect(() => {
    let active = true;
    void Promise.allSettled([bridge.getWorkspace(), bridge.getPreferences()]).then(async ([workspaceResult, preferencesResult]) => {
      if (!active) return;
      if (workspaceResult.status === "rejected") {
        const initial = emptySession("session-1", "");
        initial.status = "error";
        initial.statusLabel = "工作区读取失败";
        initial.errorText = workspaceResult.reason instanceof Error ? workspaceResult.reason.message : "无法读取当前工作区。";
        sessionsRef.current = { "session-1": initial };
        setSessions({ "session-1": initial });
        setWorkspace("工作区不可用");
        setServerState("error");
        return;
      }
      const currentWorkspace = workspaceResult.value;
      const value = preferencesResult.status === "fulfilled" ? preferencesResult.value : preferencesRef.current;
      setWorkspace(currentWorkspace);
      setPreferences((current) => ({ ...current, ...value }));
      const startupModels = initialProviderModels(value.claudeModelCache, claudeVersionForCache(claudeRuntimeStatusRef.current));
      setProviderModels((current) => ({ ...current, claude: startupModels.claude }));
      setHistory((current) => applyLocalSessionMetadata(current, value));
      const restored = parseUpdateWorkspaceState(value.workspaceState, currentWorkspace);
      if (!restored) {
        const initial = emptySession("session-1", currentWorkspace);
        sessionsRef.current = { "session-1": initial };
        setSessions({ "session-1": initial });
        if (preferencesResult.status === "rejected") {
          updateSession("session-1", (current) => ({ ...current, errorText: "本地偏好读取失败，已使用默认设置。" }));
        }
        if (Object.keys(asRecord(value.workspaceState)).length) void bridge.savePreferences({ workspaceState: {} }).catch(() => undefined);
        return;
      }

      const restoredSessions = restored.truncated
        ? Object.fromEntries(Object.entries(restored.sessions).map(([id, session]) => [id, { ...session, errorText: "更新恢复数据已按本地大小上限截断，请检查草稿和排队消息。" }]))
        : restored.sessions;
      sessionsRef.current = restoredSessions;
      layoutRef.current = restored.layout;
      draftsRef.current = restored.drafts;
      workspaceRestoreIdsRef.current = new Set(restored.threadSessionIds);
      setSessions(restoredSessions);
      setLayout(restored.layout);
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
        const mergedQueuedMessages = { ...queuedMessagesRef.current };
        for (const [sessionId, restoredMessages] of Object.entries(nextQueuedMessages)) {
          const byId = new Map(restoredMessages.map((message) => [message.id, message]));
          for (const message of mergedQueuedMessages[sessionId] || []) byId.set(message.id, message);
          mergedQueuedMessages[sessionId] = [...byId.values()].sort((left, right) => (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER));
        }
        attachmentsRef.current = mergedAttachments;
        queuedMessagesRef.current = mergedQueuedMessages;
        setAttachments(mergedAttachments);
        setQueuedMessages(mergedQueuedMessages);
        await bridge.savePreferences({ workspaceState: {} });
      } catch (error) {
        if (active) {
          setSessions((current) => Object.fromEntries(Object.entries(current).map(([id, session]) => [id, {
            ...session,
            errorText: error instanceof Error ? `本地会话恢复未完成：${error.message}` : "本地会话恢复未完成，下次启动会继续恢复。",
          }])));
        }
      } finally {
        workspaceRestoreInProgressRef.current = false;
      }
    });
    void Promise.all([
      agentClient.request("codex", "listModels", { limit: 100, includeHidden: false }),
      bridge.getCodexDefaults().catch(() => EMPTY_CODEX_DEFAULTS),
      Promise.all([
        agentClient.request("codex", "getCapabilities") as Promise<AgentCapabilities>,
        agentClient.request("claude", "getCapabilities") as Promise<AgentCapabilities>,
      ]),
    ]).then(([value, defaults, [codexCapabilities, claudeCapabilities]]) => {
      if (!active) return;
      setServerState("ready");
      setCodexDefaults(defaults);
      setProviderModels((current) => ({ ...current, codex: ((asRecord(value).data as unknown[]) || []).map((model) => normalizeAgentModel("codex", model)) }));
      setProviderCapabilities({ codex: codexCapabilities, claude: claudeCapabilities });
      const capabilities = { codex: codexCapabilities, claude: claudeCapabilities };
      setSessions((current) => Object.fromEntries(Object.entries(current).map(([id, session]) => [id, { ...session, capabilities: capabilities[session.provider] }])));
    }).catch((error) => {
      if (!active) return;
      setServerState("error");
      setSessions((current) => Object.fromEntries(Object.entries(current).map(([id, session]) => [id, {
        ...session,
        errorText: error instanceof Error ? error.message : "Codex 模型列表加载失败。",
      }])));
    });
    return () => { active = false; };
  }, [agentClient, bridge, updateSession]);

  useEffect(() => {
    if (serverState !== "ready" || !workspaceRestoreIdsRef.current.size) return;
    for (const sessionId of [...workspaceRestoreIdsRef.current]) {
      const session = sessions[sessionId];
      if (!session?.threadId) {
        workspaceRestoreIdsRef.current.delete(sessionId);
        continue;
      }
      workspaceRestoreIdsRef.current.delete(sessionId);
      providerEventRef.current?.bindSession(session.provider, session.threadId, sessionId);
      const resumePromise = sessionLifecycleRef.current.resume(sessionId, () => (
        requestForSession(sessionId, "resumeSession", { threadId: session.threadId as string, cwd: session.cwd })
      ));
      void resumePromise
        .then((resumeValue) => {
          const resume = asRecord(resumeValue);
          updateSession(sessionId, (current) => {
            const model = stringValue(resume.model, current.model);
            return { ...current, model, effort: stringValue(resume.reasoningEffort, current.effort), resumed: true, tokenUsage: tokenUsageForModel(current, model, preferencesRef.current) };
          });
        })
        .catch((error) => setError(sessionId, error, "恢复更新前会话失败"));
      const readVersion = providerEventRef.current?.captureVersion(sessionId) || { event: 0, lifecycle: 0 };
      void requestForSession(sessionId, "readSession", { threadId: session.threadId, includeTurns: true })
        .then((readValue) => {
          const preserve = providerEventRef.current?.changedSince(sessionId, readVersion) || { preserveRealtime: false, preserveLifecycle: false };
          updateSession(sessionId, (current) => hydrateAgentSession(current, current.provider, asRecord(readValue).thread, preserve));
        })
        .catch((error) => setError(sessionId, error, "读取更新前会话失败"));
    }
  }, [requestForSession, serverState, sessions, setError, updateSession]);

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
      const withDefaults = applyProviderModelDefaults(session, providerModels[session.provider], codexDefaults);
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
    const interval = window.setInterval(refresh, 30_000);
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
  const sidebarCurrentCwd = activeSession?.cwd || workspace;
  const sidebarDirectoryHistory = useMemo(() => {
    const key = normalizedDirectory(sidebarCurrentCwd);
    return key ? history.filter((entry) => entry.cwdKey === key) : [];
  }, [history, sidebarCurrentCwd]);
  const sidebarLayout = useMemo<SidebarProps["layout"]>(() => ({
    collapsed: sidebarCollapsed,
    onToggleCollapsed: toggleSidebarCollapsed,
    onResizeStart: startSidebarResize,
  }), [sidebarCollapsed, startSidebarResize, toggleSidebarCollapsed]);
  const sidebarToolbar = useMemo<SidebarProps["toolbar"]>(() => ({
    pluginMarketplaceState: activeSession?.capabilities.pluginMarketplace || "temporarilyUnavailable",
    onChooseWorkspace: chooseWorkspace,
    onRefreshHistory: refreshHistory,
    onOpenPlugins: openPluginPanel,
  }), [activeSession?.capabilities.pluginMarketplace, chooseWorkspace, openPluginPanel, refreshHistory]);
  const sidebarWorkspace = useMemo<SidebarProps["workspace"]>(() => ({
    viewModel: {
      currentCwd: sidebarCurrentCwd,
      activeCwd: sidebarCurrentCwd,
      currentDirectoryHistoryCount: sidebarDirectoryHistory.length,
      favoriteWorkspaces: preferences.favoriteWorkspaces,
    },
    actions: {
      onNewSession: createSessionInDirectory,
      onSelectWorkspace: selectWorkspace,
      onToggleFavorite: toggleFavorite,
      onSavePreference: savePreference,
    },
  }), [createSessionInDirectory, preferences.favoriteWorkspaces, savePreference, selectWorkspace, sidebarCurrentCwd, sidebarDirectoryHistory.length, toggleFavorite]);
  const sidebarHistory = useMemo<SidebarProps["history"]>(() => ({
    viewModel: {
      activeCwd: sidebarCurrentCwd,
      directoryHistory: sidebarDirectoryHistory,
      favoriteHistory,
      historyHasMore: Boolean(historyCursor),
      historyLoading,
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
      onSearchHistory: searchHistory,
      onLoadMoreHistorySearch: loadMoreHistorySearch,
    },
  }), [activeSession?.provider, favoriteHistory, historyCursor, historyLoading, historySearchCursor, historySearchLoading, historySearchResults, isHistoryWorking, liveThreadActivity, loadMoreHistory, loadMoreHistorySearch, openHistory, providerCapabilities, runHistoryAction, searchHistory, sidebarActiveThreadId, sidebarCurrentCwd, sidebarDirectoryHistory]);
  const sidebarSettings = useMemo<SidebarProps["settings"]>(() => ({
    viewModel: {
      theme: preferences.theme,
      baseFontSize,
      displayMode,
      updateStatus,
      cliUpdateStatus,
      claudeStatus: claudeRuntimeStatus,
      bossKeyStatus,
      activeClaudeWorkspace: workspaceForProvider(activeSession, "claude"),
    },
    actions: {
      onSavePreference: savePreference,
      onSetBossKey: setBossKey,
      onSaveUpdateToken: saveUpdateToken,
      onClearUpdateToken: clearUpdateToken,
      onCheckForUpdates: checkForUpdates,
      onCheckCodexCliUpdates: checkCodexCliUpdates,
      onUpdateCodexCli: updateCodexCli,
      onCheckClaude: checkClaudeCodeUpdates,
      onUpdateClaude: updateClaudeCode,
      onRevokeClaudeWorkspace: revokeClaudeWorkspace,
      onDownloadUpdate: downloadUpdate,
      onInstallUpdate: installUpdate,
      onOpenUpdateTokenPage: openUpdateTokenPage,
    },
  }), [activeSession, baseFontSize, bossKeyStatus, checkClaudeCodeUpdates, checkCodexCliUpdates, checkForUpdates, claudeRuntimeStatus, clearUpdateToken, cliUpdateStatus, displayMode, downloadUpdate, installUpdate, openUpdateTokenPage, preferences.theme, revokeClaudeWorkspace, savePreference, saveUpdateToken, setBossKey, updateClaudeCode, updateCodexCli, updateStatus]);

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
        onOpenTerminal={openWindowsTerminal}
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
              if (sessionId) moveTab(sessionId, pane.id);
            }}
          >
            <div className="tab-list">
              {pane.tabIds.map((id) => sessions[id]).filter(Boolean).map((session) => (
                <button
                  className={`tab ${session.id === pane.activeTabId ? "active" : ""} ${draggingTabId === session.id ? "dragging" : ""} ${tabDropTarget?.paneId === pane.id && tabDropTarget.sessionId === session.id ? `drop-${tabDropTarget.position}` : ""}`}
                  draggable
                  title={`${session.title}\n${session.cwd}`}
                  onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/tab", session.id);
                    setDraggingTabId(session.id);
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
                    if (draggedId && draggedId !== session.id) moveTab(draggedId, pane.id, { paneId: pane.id, sessionId: session.id, position });
                  }}
                  onDragEnd={() => { setDraggingTabId(null); setTabDropPaneId(null); setTabDropTarget(null); }}
                  onClick={() => { setTabContextMenu(null); setActiveTab(pane.id, session.id); }}
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
        <div className="tab-actions">
          <button className="icon-button provider-new codex" onClick={() => createSessionInDirectory(activeSession?.cwd || workspace, "codex")} title="新建 Codex 会话" aria-label="新建 Codex 会话"><ProviderIcon provider="codex" size={15} /></button>
          <button className="icon-button provider-new claude" onClick={() => createSessionInDirectory(activeSession?.cwd || workspace, "claude")} title="新建 Claude Code 会话" aria-label="新建 Claude Code 会话"><ProviderIcon provider="claude" size={15} /></button>
          <button className="icon-button" disabled={layout.panes.length >= 2} onClick={() => splitPane(activePane?.id || "pane-1", 2)} title="分成两列" aria-label="分成两列"><Columns2 size={16} /></button>
        </div>
      </div>
      <div className="panes-grid" style={{ gridTemplateColumns: layout.panes.length === 3 ? "repeat(3, minmax(0, 1fr))" : layout.panes.length === 2 ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)" }}>
        {layout.panes.map(renderPane)}
      </div>
    </div>
    {pluginPanelOpen ? <Suspense fallback={<div className="plugin-overlay" role="dialog" aria-modal="true" aria-label="正在打开插件市场"><section className="plugin-panel lazy-panel-loading">正在打开插件市场</section></div>}><PluginPanel cwd={activeSession?.cwd || workspace} request={requestForPluginPanel} onClose={closePluginPanel} /></Suspense> : null}
    {tabContextMenu && contextPane ? <div
      className="tab-context-menu"
      role="menu"
      aria-label={`${contextSession?.title || "当前 Tab"} 会话操作`}
      style={{ left: Math.min(tabContextMenu.x, Math.max(8, window.innerWidth - 190)), top: Math.min(tabContextMenu.y, Math.max(8, window.innerHeight - 394)) }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
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
      {contextSession?.capabilities.delete !== "unsupported" ? <button className="danger" type="button" role="menuitem" disabled={!contextSession || contextSession.capabilities.delete !== "supported"} onClick={() => { if (!contextSession) return; void deleteSession(contextSession.id); }}><Trash2 size={14} /><span>永久删除本机会话</span></button> : null}
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
