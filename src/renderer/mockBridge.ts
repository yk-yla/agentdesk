import type { AgentEventEnvelope, AgentOperation, AgentProvider } from "../shared/agentProtocol";
import type { AgentBridge, BossKeyStatus, ClaudeRuntimeStatus, CodexBridge, CodexCliUpdateStatus, CodexDefaults, DesktopPreferences, DesktopUpdateStatus, JsonRpcMessage } from "../shared/protocol";
import { asRecord, stringValue } from "./domain";

/** 浏览器预览用的假桥接。真实 Electron 走 preload 暴露的 window.agentDesk。 */
export function createMockBridge(): CodexBridge {
  const listeners = new Set<(message: JsonRpcMessage) => void>();
  const cliUpdateListeners = new Set<(status: CodexCliUpdateStatus) => void>();
  const claudeUpdateListeners = new Set<(status: ClaudeRuntimeStatus) => void>();
  const models = [
    { id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "通用编码模型", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }], defaultReasoningEffort: "high", inputModalities: ["text", "image"] },
    { id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5", description: "稳定高质量", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }], defaultReasoningEffort: "medium", inputModalities: ["text", "image"] },
    { id: "gpt-5.4-mini", model: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", description: "快速轻量", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }], defaultReasoningEffort: "medium", inputModalities: ["text"] },
  ];
  const emit = (message: JsonRpcMessage) => listeners.forEach((listener) => listener(message));
  let threadCounter = 0;
  let turnCounter = 0;
  const mockWorkspace = "mock-workspace";
  let mockPreferences: DesktopPreferences = { lastWorkspace: mockWorkspace, favoriteWorkspaces: [], sidebarWidth: 250, theme: "github-light", displayMode: "simple", bossKey: "F2" };
  let mockBossKeyStatus: BossKeyStatus = { accelerator: "F2", registered: true, message: "老板键 F2 已启用。" };
  let mockUpdateStatus: DesktopUpdateStatus = { phase: "unsupported", currentVersion: "1.0.7", message: "浏览器预览不检查软件更新。", repositoryUrl: "https://github.com/yk-yla/agentdesk" };
  let mockCodexCliUpdateStatus: CodexCliUpdateStatus = { phase: "available", currentVersion: "0.146.1", latestVersion: "0.147.0", checkedAt: Date.now(), nextCheckAt: Date.now() + 6 * 60 * 60 * 1000, message: "发现新版本 0.147.0，可立即更新。" };
  let mockClaudeRuntimeStatus: ClaudeRuntimeStatus = { phase: "available", binarySource: "sdk", binaryVersion: "1.0.0", sdkVersion: "0.1.0", latestVersion: "1.1.0", checkedAt: Date.now(), credentialsAvailable: true, credentialSource: "settings", credentialMessage: "已从 Claude 配置读取凭据。", integrityVerified: true, message: "发现 Claude Code 新版本 1.1.0。" };
  let mockWindowMaximized = false;
  const mockDefaults: CodexDefaults = { model: "gpt-5.6-sol", effort: "xhigh" };
  const mockSkills = [
    { name: "commit", description: "整理并提交当前更改", path: "mock-skills/commit/SKILL.md", scope: "user", enabled: true },
    { name: "review", description: "按项目规则检查代码", path: "mock-skills/review/SKILL.md", scope: "repo", enabled: true },
  ];
  const mockPlugins = [
    { id: "mock-security", name: "security", installed: true, enabled: true, version: "1.0.0", localVersion: "1.0.0", interface: { shortDescription: "扫描常见代码安全问题", category: "代码质量", capabilities: ["skills", "hooks"] }, source: { type: "remote" } },
    { id: "mock-release", name: "release-notes", installed: false, enabled: true, version: "0.4.0", localVersion: null, interface: { shortDescription: "整理版本发布说明", category: "工作流", capabilities: ["skills"] }, source: { type: "remote" } },
  ];
  const threadMap = new Map<string, { id: string; cwd: string; name: string; turns: unknown[]; isPinned: boolean }>();
  const goalMap = new Map<string, { threadId: string; objective: string; status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete"; tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number; createdAt: number; updatedAt: number }>();
  const activeTurns = new Map<string, { id: string; steerable: boolean }>();
  return {
    request(method, params = {}) {
      if (method === "model/list") return Promise.resolve({ data: models, nextCursor: null });
      if (method === "skills/list") return Promise.resolve({ data: [{ cwd: stringValue(params.cwds && Array.isArray(params.cwds) ? params.cwds[0] : undefined, mockWorkspace), skills: mockSkills, errors: [] }] });
      if (method === "collaborationMode/list") return Promise.resolve({ data: [{ name: "default", mode: "default", model: models[0].id, reasoning_effort: "high" }, { name: "plan", mode: "plan", model: models[0].id, reasoning_effort: "high" }] });
      if (method === "plugin/list") return Promise.resolve({ marketplaces: [{ name: "Codex 官方市场", path: null, plugins: mockPlugins }] });
      if (method === "plugin/install") { const plugin = mockPlugins.find((entry) => entry.name === stringValue(params.pluginName)); if (plugin) plugin.installed = true; return Promise.resolve({ appsNeedingAuth: [], authPolicy: "ON_USE" }); }
      if (method === "plugin/uninstall") { const plugin = mockPlugins.find((entry) => entry.id === stringValue(params.pluginId)); if (plugin) plugin.installed = false; return Promise.resolve({}); }
      if (method === "plugin/read") { const plugin = mockPlugins.find((entry) => entry.name === stringValue(params.pluginName)); return Promise.resolve({ plugin: plugin ? { summary: plugin, marketplaceName: "Codex 官方市场", marketplacePath: null, description: stringValue(asRecord(asRecord(plugin).interface).longDescription), skills: [{ name: `${plugin.name}-skill`, description: "Mock skill", enabled: true }], apps: [], hooks: [{ eventName: "userPromptSubmit", key: "mock" }], mcpServers: ["mock-server"], scheduledTasks: [] } : null }); }
      if (method === "marketplace/add") return Promise.resolve({ alreadyAdded: false, installedRoot: "mock-marketplace", marketplaceName: "本地市场" });
      if (method === "marketplace/upgrade") return Promise.resolve({ errors: [], selectedMarketplaces: [], upgradedRoots: [] });
      if (method === "marketplace/remove") return Promise.resolve({});
      if (method === "account/rateLimits/read") return Promise.resolve({ rateLimits: { primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, secondary: null } });
      if (method === "mcpServerStatus/list") return Promise.resolve({ data: [{ name: "filesystem", tools: { read_file: {}, write_file: {} }, authStatus: "unsupported" }], nextCursor: null });
      if (method === "thread/list") {
        return Promise.resolve({ data: [...threadMap.values()].map((thread) => ({ id: thread.id, cwd: thread.cwd, preview: thread.name, name: thread.name, updatedAt: Date.now() / 1000, createdAt: Date.now() / 1000, source: "appServer", isPinned: thread.isPinned, turns: [] })), nextCursor: null });
      }
      if (method === "thread/search") {
        const needle = stringValue(params.searchTerm).toLowerCase();
        const data = [...threadMap.values()].filter((thread) => thread.name.toLowerCase().includes(needle)).map((thread) => ({ thread: { id: thread.id, cwd: thread.cwd, preview: thread.name, name: thread.name, updatedAt: Date.now() / 1000, createdAt: Date.now() / 1000, source: "appServer", isPinned: thread.isPinned, turns: [] }, snippet: thread.name }));
        return Promise.resolve({ data, nextCursor: null });
      }
      if (method === "thread/start") {
        const id = `mock-thread-${++threadCounter}`;
        const thread = { id, cwd: stringValue(params.cwd, mockWorkspace), name: "新会话", turns: [], isPinned: false };
        threadMap.set(id, thread);
        window.setTimeout(() => emit({ method: "thread/started", params: { thread } }), 20);
        return Promise.resolve({ thread, model: stringValue(params.model, models[0].id), reasoningEffort: stringValue(params.effort, "high") });
      }
      if (method === "thread/name/set") {
        const thread = threadMap.get(stringValue(params.threadId));
        if (thread) thread.name = stringValue(params.name, thread.name);
        return Promise.resolve({});
      }
      if (method === "session/title/generate") return Promise.resolve({ title: "Mock 会话标题", source: "generated" });
      if (method === "thread/metadata/update") {
        const thread = threadMap.get(stringValue(params.threadId));
        if (thread && typeof params.isPinned === "boolean") thread.isPinned = params.isPinned;
        return Promise.resolve({});
      }
      if (method === "thread/fork") {
        const source = threadMap.get(stringValue(params.threadId));
        const id = `mock-thread-${++threadCounter}`;
        const thread = { id, cwd: stringValue(params.cwd, source?.cwd || mockWorkspace), name: source?.name || "分支会话", turns: [...(source?.turns || [])], isPinned: false };
        threadMap.set(id, thread);
        window.setTimeout(() => emit({ method: "thread/started", params: { thread } }), 20);
        return Promise.resolve({ thread, model: models[0].id, cwd: thread.cwd, reasoningEffort: "high" });
      }
      if (method === "thread/delete") {
        const id = stringValue(params.threadId);
        threadMap.delete(id);
        goalMap.delete(id);
        window.setTimeout(() => emit({ method: "thread/deleted", params: { threadId: id } }), 10);
        return Promise.resolve({});
      }
      if (method === "thread/goal/get") return Promise.resolve({ goal: goalMap.get(stringValue(params.threadId)) || null });
      if (method === "thread/goal/set") {
        const threadId = stringValue(params.threadId);
        const previous = goalMap.get(threadId);
        const now = Date.now();
        const goal = {
          threadId,
          objective: stringValue(params.objective, previous?.objective || "持续完成当前任务"),
          status: (stringValue(params.status, previous?.status || "active") as "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete"),
          tokenBudget: typeof params.tokenBudget === "number" ? params.tokenBudget : previous?.tokenBudget || null,
          tokensUsed: previous?.tokensUsed || 0,
          timeUsedSeconds: previous?.timeUsedSeconds || 0,
          createdAt: previous?.createdAt || now,
          updatedAt: now,
        };
        goalMap.set(threadId, goal);
        window.setTimeout(() => emit({ method: "thread/goal/updated", params: { threadId, turnId: null, goal } }), 10);
        return Promise.resolve({ goal });
      }
      if (method === "thread/goal/clear") {
        const threadId = stringValue(params.threadId);
        goalMap.delete(threadId);
        window.setTimeout(() => emit({ method: "thread/goal/cleared", params: { threadId } }), 10);
        return Promise.resolve({ cleared: true });
      }
      if (method === "thread/read" || method === "thread/resume") {
        const thread = threadMap.get(stringValue(params.threadId));
        return Promise.resolve({ thread: thread ?? { id: params.threadId, cwd: stringValue(params.cwd), name: "历史会话", turns: [] }, model: models[0].id, reasoningEffort: "high" });
      }
      if (method === "turn/start" || method === "review/start") {
        const threadId = stringValue(params.threadId);
        const turnId = `mock-turn-${++turnCounter}`;
        const itemId = `mock-item-${turnCounter}`;
        const userItemId = `mock-user-${turnCounter}`;
        const isReview = method === "review/start";
        const input = isReview ? [{ type: "text", text: "审查当前目录的未提交更改", text_elements: [] }] : Array.isArray(params.input) ? params.input : [];
        const prompt = input.map((item) => stringValue(asRecord(item).text)).filter(Boolean).join(" ");
        const simulateRetry = prompt.includes("[mock-retry]");
        const clientUserMessageId = stringValue(params.clientUserMessageId);
        const text = prompt ? `已收到：${prompt}\n\n这是浏览器预览中的 Markdown 回复。\n\n- 当前模型：${stringValue(params.model, "gpt-5.6-sol")}\n- 思考等级：${stringValue(params.effort, "high")}\n\n\`\`\`ts\nconst ready = true;\n\`\`\`` : "已连接 Codex。";
        const thread = threadMap.get(threadId);
        if (thread) thread.turns.push({ items: [...(isReview ? [] : [{ type: "userMessage", id: userItemId, content: input }]), { type: "agentMessage", id: itemId, text }] });
        activeTurns.set(threadId, { id: turnId, steerable: !prompt.includes("[non-steerable]") });
        if (params.collaborationMode && stringValue(asRecord(params.collaborationMode).mode) === "plan") window.setTimeout(() => emit({ method: "turn/plan/updated", params: { threadId, turnId, explanation: "先确认实现路径，再逐步完成任务。", plan: [{ step: "分析需求和现状", status: "completed" }, { step: "执行实现", status: "inProgress" }, { step: "验证结果", status: "pending" }] } }), 140);
        if (params.multiAgentMode === "proactive") {
          const agentThreadId = `mock-agent-thread-${turnCounter}`;
          window.setTimeout(() => emit({ method: "item/started", params: { threadId, turnId, item: { id: `mock-agent-call-${turnCounter}`, type: "collabAgentToolCall", tool: "spawnAgent", status: "inProgress", prompt: "并行检查相关实现", receiverThreadIds: [agentThreadId], agentsStates: {} } } }), 180);
          window.setTimeout(() => emit({ method: "thread/started", params: { thread: { id: agentThreadId, parentThreadId: threadId, agentNickname: "探索 Agent", agentRole: "explorer", turns: [] } } }), 240);
          window.setTimeout(() => emit({ method: "turn/started", params: { threadId: agentThreadId, turn: { id: `mock-agent-turn-${turnCounter}`, status: "inProgress" } } }), 300);
          window.setTimeout(() => emit({ method: "item/agentMessage/delta", params: { threadId: agentThreadId, turnId: `mock-agent-turn-${turnCounter}`, itemId: `mock-agent-message-${turnCounter}`, delta: "已完成并行检查，未发现阻塞问题。" } }), 700);
          window.setTimeout(() => emit({ method: "turn/completed", params: { threadId: agentThreadId, turn: { id: `mock-agent-turn-${turnCounter}`, status: "completed" } } }), 1100);
        }
        window.setTimeout(() => emit({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } }), 80);
        if (!isReview) window.setTimeout(() => emit({ method: "item/started", params: { threadId, turnId, item: { id: userItemId, type: "userMessage", content: input, clientId: clientUserMessageId || null } } }), 100);
        window.setTimeout(() => emit({ method: "item/started", params: { threadId, turnId, item: { id: itemId, type: "agentMessage", text: "" } } }), 120);
        if (simulateRetry) {
          const retryMessage = "Stream disconnected before completion: Upstream service temporarily unavailable";
          window.setTimeout(() => emit({ method: "error", params: { threadId, turnId, error: { message: retryMessage }, willRetry: true } }), 260);
          window.setTimeout(() => emit({ method: "error", params: { threadId, turnId, error: { message: retryMessage }, willRetry: true } }), 860);
        }
        if (prompt.includes("[mock-user-input]")) window.setTimeout(() => emit({
          id: 7000 + turnCounter,
          method: "item/tool/requestUserInput",
          params: {
            threadId,
            turnId,
            itemId: `mock-request-${turnCounter}`,
            questions: [
              { id: "scope", header: "实现范围", question: "这次要覆盖哪些界面？", multiSelect: true, isOther: true, options: [{ label: "会话区", description: "主对话与输入区域" }, { label: "设置面板", description: "侧栏与设置区域" }] },
              { id: "note", header: "补充", question: "还有什么需要注意？" },
            ],
          },
        }), 260);
        if (prompt.includes("[mock-permissions]")) window.setTimeout(() => emit({
          id: 8000 + turnCounter,
          method: "item/permissions/requestApproval",
          params: {
            threadId,
            turnId,
            itemId: `mock-permissions-${turnCounter}`,
            reason: "需要读取依赖目录并访问文档站点",
            permissions: { fileSystem: { read: [mockWorkspace], write: null }, network: { enabled: true } },
          },
        }), 260);
        const outputStart = simulateRetry ? 1_500 : 180;
        for (let index = 0; index < text.length; index += 10) window.setTimeout(() => emit({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: text.slice(index, index + 10) } }), outputStart + index * 12);
        window.setTimeout(() => {
          if (activeTurns.get(threadId)?.id !== turnId) return;
          emit({ method: "item/completed", params: { threadId, turnId, item: { id: itemId, type: "agentMessage", text } } });
          emit({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: { totalTokens: text.length * 2 }, last: { totalTokens: text.length * 2 }, modelContextWindow: 258000 } } });
          emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
          activeTurns.delete(threadId);
        }, simulateRetry ? 4_000 : 1_900);
        return Promise.resolve({ turn: { id: turnId, status: "inProgress" }, ...(isReview ? { reviewThreadId: threadId } : {}) });
      }
      if (method === "turn/steer") {
        const threadId = stringValue(params.threadId);
        const active = activeTurns.get(threadId);
        if (!active) return Promise.reject(new Error("no active turn to steer"));
        const expectedTurnId = stringValue(params.expectedTurnId);
        if (expectedTurnId && expectedTurnId !== active.id) {
          return Promise.reject(new Error(`expected active turn id \`${expectedTurnId}\` but found \`${active.id}\``));
        }
        if (!active.steerable) return Promise.reject(new Error("cannot steer a review turn"));
        const input = Array.isArray(params.input) ? params.input : [];
        const clientId = stringValue(params.clientUserMessageId);
        const itemId = `mock-steer-${++turnCounter}`;
        window.setTimeout(() => {
          if (activeTurns.get(threadId)?.id !== active.id) return;
          emit({ method: "item/started", params: { threadId, turnId: active.id, item: { id: itemId, type: "userMessage", content: input, clientId } } });
          emit({ method: "item/completed", params: { threadId, turnId: active.id, item: { id: itemId, type: "userMessage", content: input, clientId } } });
        }, 450);
        return Promise.resolve({ turnId: active.id });
      }
      if (method === "turn/interrupt") {
        const threadId = stringValue(params.threadId);
        const active = activeTurns.get(threadId);
        if (active) {
          activeTurns.delete(threadId);
          window.setTimeout(() => emit({ method: "turn/completed", params: { threadId, turn: { id: active.id, status: "interrupted" } } }), 50);
        }
        return Promise.resolve({});
      }
      if (method === "thread/compact/start") {
        const threadId = stringValue(params.threadId);
        emit({ method: "item/completed", params: { threadId, turnId: "compact", item: { id: `compact-${Date.now()}`, type: "contextCompaction" } } });
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
    respond: () => Promise.resolve(),
    getWorkspace: () => Promise.resolve(mockWorkspace),
    getLaunchProvider: () => Promise.resolve(null),
    chooseWorkspace: (defaultPath?: string) => Promise.resolve(defaultPath || mockWorkspace),
    chooseClaudeMarketplaceDirectory: (defaultPath?: string) => Promise.resolve(defaultPath || mockWorkspace),
    registerWorkspace: (cwd: string) => Promise.resolve(cwd),
    getPreferences: () => Promise.resolve(mockPreferences),
    getCodexDefaults: () => Promise.resolve(mockDefaults),
    savePreferences: (preferences) => { mockPreferences = { ...mockPreferences, ...preferences }; return Promise.resolve(mockPreferences); },
    writeLog: () => Promise.resolve(),
    exportDiagnostics: () => Promise.resolve(null),
    getBossKeyStatus: () => Promise.resolve(mockBossKeyStatus),
    setBossKey: (accelerator) => {
      mockBossKeyStatus = { accelerator, registered: true, message: `老板键 ${accelerator} 已启用。` };
      mockPreferences = { ...mockPreferences, bossKey: accelerator };
      return Promise.resolve(mockBossKeyStatus);
    },
    saveClipboardImage: (dataUrl, suggestedName) => Promise.resolve({ path: "mock://image", dataUrl, name: suggestedName || "粘贴图片" }),
    copyImage: () => Promise.resolve(),
    saveTextFile: () => Promise.resolve({ path: "mock://codex-session.md" }),
    createHandoffPackage: () => Promise.resolve({ path: "mock://handoff.md", prompt: "请读取交接材料并继续完成任务。" }),
    openWindowsTerminal: () => Promise.resolve(),
    readLocalImage: () => Promise.resolve(null),
    openLocalPath: () => Promise.resolve(""),
    openExternal: () => Promise.resolve(),
    showNotification: () => Promise.resolve(true),
    getWindowState: () => Promise.resolve({ maximized: mockWindowMaximized }),
    minimizeWindow: () => Promise.resolve(),
    toggleMaximizeWindow: () => {
      mockWindowMaximized = !mockWindowMaximized;
      return Promise.resolve({ maximized: mockWindowMaximized });
    },
    getUpdateStatus: () => Promise.resolve(mockUpdateStatus),
    checkForUpdates: () => Promise.resolve(mockUpdateStatus),
    downloadUpdate: () => Promise.resolve(mockUpdateStatus),
    installUpdate: () => Promise.resolve(),
    saveWorkspaceSnapshot: (_requestId, workspaceState) => {
      mockPreferences = { ...mockPreferences, workspaceState };
      return Promise.resolve();
    },
    getCodexCliUpdateStatus: () => Promise.resolve(mockCodexCliUpdateStatus),
    checkCodexCliUpdates: () => Promise.resolve(mockCodexCliUpdateStatus),
    updateCodexCli: () => {
      mockCodexCliUpdateStatus = { ...mockCodexCliUpdateStatus, phase: "updating", message: "正在停止所有 Codex app-server。", nextCheckAt: undefined };
      cliUpdateListeners.forEach((listener) => listener(mockCodexCliUpdateStatus));
      return new Promise((resolve) => window.setTimeout(() => {
        const version = mockCodexCliUpdateStatus.latestVersion || mockCodexCliUpdateStatus.currentVersion;
        mockCodexCliUpdateStatus = { ...mockCodexCliUpdateStatus, phase: "upToDate", currentVersion: version, latestVersion: version, checkedAt: Date.now(), nextCheckAt: Date.now() + 6 * 60 * 60 * 1000, message: `已更新到 ${version}，桌面端 Codex 服务已恢复。` };
        cliUpdateListeners.forEach((listener) => listener(mockCodexCliUpdateStatus));
        resolve(mockCodexCliUpdateStatus);
      }, 1_200));
    },
    onWindowState: () => () => undefined,
    onWorkspaceSnapshotRequested: () => () => undefined,
    onUpdateStatus: () => () => undefined,
    onCodexCliUpdateStatus(listener) {
      cliUpdateListeners.add(listener);
      return () => cliUpdateListeners.delete(listener);
    },
    getClaudeRuntimeStatus: () => Promise.resolve(mockClaudeRuntimeStatus),
    checkClaudeCodeUpdates: () => Promise.resolve(mockClaudeRuntimeStatus),
    updateClaudeCode: () => {
      mockClaudeRuntimeStatus = { ...mockClaudeRuntimeStatus, phase: "updated", binarySource: "managed", binaryVersion: mockClaudeRuntimeStatus.latestVersion || mockClaudeRuntimeStatus.binaryVersion, message: "Claude Code 已更新。", checkedAt: Date.now() };
      claudeUpdateListeners.forEach((listener) => listener(mockClaudeRuntimeStatus));
      return Promise.resolve(mockClaudeRuntimeStatus);
    },
    onClaudeRuntimeStatus(listener) {
      claudeUpdateListeners.add(listener);
      return () => claudeUpdateListeners.delete(listener);
    },
    onMessage(listener) {
      listeners.add(listener);
      const ready = window.setTimeout(() => emit({ method: "client/ready", params: {} }), 30);
      return () => { window.clearTimeout(ready); listeners.delete(listener); };
    },
  };
}

const MOCK_METHODS: Record<Exclude<AgentOperation, "getCapabilities" | "closeSession">, string> = {
  listModels: "model/list", listSkills: "skills/list", listSessions: "thread/list", searchSessions: "thread/search", generateSessionTitle: "session/title/generate",
  readSession: "thread/read", startSession: "thread/start", resumeSession: "thread/resume", forkSession: "thread/fork",
  renameSession: "thread/name/set", deleteSession: "thread/delete", updateSessionMetadata: "thread/metadata/update",
  updateSessionSettings: "thread/settings/update", startTurn: "turn/start", startReview: "review/start", steerTurn: "turn/steer",
  interruptTurn: "turn/interrupt", compactSession: "thread/compact/start", readRateLimits: "account/rateLimits/read",
  listMcpServers: "mcpServerStatus/list", getGoal: "thread/goal/get", setGoal: "thread/goal/set", clearGoal: "thread/goal/clear",
  listPlugins: "plugin/list", readPlugin: "plugin/read", installPlugin: "plugin/install", uninstallPlugin: "plugin/uninstall", updatePlugin: "plugin/install",
  addMarketplace: "marketplace/add", updateMarketplace: "marketplace/upgrade", removeMarketplace: "marketplace/remove",
};

export function createMockAgentBridge(): AgentBridge {
  const legacy = createMockBridge();
  return {
    ...legacy,
    agentRequest(provider: AgentProvider, operation: AgentOperation, params = {}, context = {}) {
      if (provider !== "codex") return Promise.reject(new Error("浏览器预览暂不模拟 Claude。"));
      if (operation === "getCapabilities") return Promise.resolve({});
      if (operation === "closeSession") return Promise.resolve();
      return legacy.request(MOCK_METHODS[operation], params, { sessionId: context.sessionId });
    },
    respondToInteraction({ ref, result }) {
      if (ref.requestId === undefined) return Promise.reject(new Error("交互引用无效。"));
      return legacy.respond(ref.requestId, result);
    },
    onAgentEvent(listener: (event: AgentEventEnvelope) => void) {
      return legacy.onMessage((message) => listener({
        provider: "codex",
        requestId: message.id,
        receivedAt: Date.now(),
        type: message.method || "codex/unknown",
        payload: message.params ?? message.result ?? message.error ?? {},
      }));
    },
  };
}
