import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AgentEventEnvelope, AgentInteractionResponse, AgentOperation, AgentProvider, AgentRequestContext } from "../shared/agentProtocol";
import type { AgentBridge, ClaudeRuntimeStatus, CodexBridge, CodexCliUpdateStatus, DesktopPreferences, DesktopUpdateStatus, DesktopWindowState, ExternalTerminalOpenRequest, JsonObject, ClientLogEntry } from "../shared/protocol";

const bridge: Omit<CodexBridge, "request" | "respond" | "onMessage"> = {
  getWorkspace() {
    return ipcRenderer.invoke("agentdesk:get-workspace");
  },
  getLaunchProvider() {
    return ipcRenderer.invoke("agentdesk:get-launch-provider");
  },
  chooseWorkspace(defaultPath?: string) {
    return ipcRenderer.invoke("agentdesk:choose-workspace", defaultPath);
  },
  registerWorkspace(cwd: string) {
    return ipcRenderer.invoke("agentdesk:register-workspace", cwd);
  },
  getPreferences() {
    return ipcRenderer.invoke("agentdesk:get-preferences");
  },
  getCodexDefaults() {
    return ipcRenderer.invoke("agentdesk:get-codex-defaults");
  },
  savePreferences(preferences: Partial<DesktopPreferences>) {
    return ipcRenderer.invoke("agentdesk:save-preferences", preferences);
  },
  writeLog(entry: ClientLogEntry) {
    return ipcRenderer.invoke("agentdesk:write-log", entry);
  },
  exportDiagnostics() {
    return ipcRenderer.invoke("agentdesk:export-diagnostics");
  },
  saveClipboardImage(dataUrl: string, suggestedName?: string) {
    return ipcRenderer.invoke("agentdesk:save-clipboard-image", { dataUrl, suggestedName });
  },
  readClipboardText() {
    return ipcRenderer.invoke("agentdesk:read-clipboard-text");
  },
  writeClipboardText(text: string) {
    return ipcRenderer.invoke("agentdesk:write-clipboard-text", text);
  },
  copyImage(dataUrl: string) {
    return ipcRenderer.invoke("agentdesk:copy-image", dataUrl);
  },
  getPastedFilePath(file: unknown) {
    let filePath = "";
    try {
      filePath = webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]);
    } catch {
      return Promise.resolve(null);
    }
    return filePath ? ipcRenderer.invoke("agentdesk:authorize-pasted-file", filePath) : Promise.resolve(null);
  },
  saveTextFile(content: string, suggestedName?: string) {
    return ipcRenderer.invoke("agentdesk:save-text-file", { content, suggestedName });
  },
  createHandoffPackage(input) {
    return ipcRenderer.invoke("agentdesk:create-handoff", input);
  },
  readLocalImage(filePath: string) {
    return ipcRenderer.invoke("agentdesk:read-local-image", filePath);
  },
  openLocalPath(input: Parameters<AgentBridge["openLocalPath"]>[0]) {
    return ipcRenderer.invoke("agentdesk:open-local-path", input);
  },
  openExternal(url: string) {
    return ipcRenderer.invoke("agentdesk:open-external", url);
  },
  openExternalTerminal(input: ExternalTerminalOpenRequest) {
    return ipcRenderer.invoke("agentdesk:open-external-terminal", input);
  },
  showNotification(notification) {
    return ipcRenderer.invoke("agentdesk:show-notification", notification);
  },
  getWindowState() {
    return ipcRenderer.invoke("agentdesk:window-state");
  },
  minimizeWindow() {
    return ipcRenderer.invoke("agentdesk:window-minimize");
  },
  toggleMaximizeWindow() {
    return ipcRenderer.invoke("agentdesk:window-toggle-maximize");
  },
  getUpdateStatus() {
    return ipcRenderer.invoke("agentdesk:update-status");
  },
  checkForUpdates() {
    return ipcRenderer.invoke("agentdesk:update-check");
  },
  downloadUpdate() {
    return ipcRenderer.invoke("agentdesk:update-download");
  },
  installUpdate() {
    return ipcRenderer.invoke("agentdesk:update-install");
  },
  saveWorkspaceSnapshot(requestId: string, workspaceState: JsonObject) {
    return ipcRenderer.invoke("agentdesk:workspace-snapshot-save", { requestId, workspaceState });
  },
  onWindowState(listener: (state: DesktopWindowState) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, state: DesktopWindowState) => listener(state);
    ipcRenderer.on("agentdesk:window-state-changed", wrapped);
    return () => ipcRenderer.removeListener("agentdesk:window-state-changed", wrapped);
  },
  onWorkspaceSnapshotRequested(listener: (requestId: string) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, requestId: string) => listener(requestId);
    ipcRenderer.on("agentdesk:workspace-snapshot-requested", wrapped);
    return () => ipcRenderer.removeListener("agentdesk:workspace-snapshot-requested", wrapped);
  },
  onUpdateStatus(listener: (status: DesktopUpdateStatus) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, status: DesktopUpdateStatus) => listener(status);
    ipcRenderer.on("agentdesk:update-status-changed", wrapped);
    return () => ipcRenderer.removeListener("agentdesk:update-status-changed", wrapped);
  },
  getCodexCliUpdateStatus() {
    return ipcRenderer.invoke("agentdesk:cli-update-status");
  },
  checkCodexCliUpdates() {
    return ipcRenderer.invoke("agentdesk:cli-update-check");
  },
  updateCodexCli() {
    return ipcRenderer.invoke("agentdesk:cli-update-install");
  },
  onCodexCliUpdateStatus(listener: (status: CodexCliUpdateStatus) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, status: CodexCliUpdateStatus) => listener(status);
    ipcRenderer.on("agentdesk:cli-update-status-changed", wrapped);
    return () => ipcRenderer.removeListener("agentdesk:cli-update-status-changed", wrapped);
  },
  getClaudeRuntimeStatus() {
    return ipcRenderer.invoke("claude:runtime-status");
  },
  checkClaudeCodeUpdates() {
    return ipcRenderer.invoke("claude:update-check");
  },
  updateClaudeCode(allowUnverified: boolean) {
    return ipcRenderer.invoke("claude:update-install", allowUnverified);
  },
  onClaudeRuntimeStatus(listener: (status: ClaudeRuntimeStatus) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, status: ClaudeRuntimeStatus) => listener(status);
    ipcRenderer.on("claude:runtime-status-changed", wrapped);
    return () => ipcRenderer.removeListener("claude:runtime-status-changed", wrapped);
  },
};

const agentBridge: AgentBridge = {
  agentRequest(provider: AgentProvider, operation: AgentOperation, params: JsonObject = {}, context: AgentRequestContext = {}) {
    return ipcRenderer.invoke("agent:request", { provider, operation, params, context });
  },
  respondToInteraction(response: AgentInteractionResponse) {
    return ipcRenderer.invoke("agent:respond", response);
  },
  onAgentEvent(listener: (event: AgentEventEnvelope) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, event: AgentEventEnvelope) => listener(event);
    ipcRenderer.on("agent:event", wrapped);
    return () => ipcRenderer.removeListener("agent:event", wrapped);
  },
  getWorkspace: bridge.getWorkspace,
  getLaunchProvider: bridge.getLaunchProvider,
  chooseWorkspace: bridge.chooseWorkspace,
  registerWorkspace: bridge.registerWorkspace,
  getPreferences: bridge.getPreferences,
  getCodexDefaults: bridge.getCodexDefaults,
  savePreferences: bridge.savePreferences,
  writeLog: bridge.writeLog,
  exportDiagnostics: bridge.exportDiagnostics,
  saveClipboardImage: bridge.saveClipboardImage,
  readClipboardText: bridge.readClipboardText,
  writeClipboardText: bridge.writeClipboardText,
  copyImage: bridge.copyImage,
  getPastedFilePath: bridge.getPastedFilePath,
  saveTextFile: bridge.saveTextFile,
  createHandoffPackage: bridge.createHandoffPackage,
  readLocalImage: bridge.readLocalImage,
  openLocalPath: bridge.openLocalPath,
  openExternal: bridge.openExternal,
  openExternalTerminal: bridge.openExternalTerminal,
  showNotification: bridge.showNotification,
  getWindowState: bridge.getWindowState,
  minimizeWindow: bridge.minimizeWindow,
  toggleMaximizeWindow: bridge.toggleMaximizeWindow,
  getUpdateStatus: bridge.getUpdateStatus,
  checkForUpdates: bridge.checkForUpdates,
  downloadUpdate: bridge.downloadUpdate,
  installUpdate: bridge.installUpdate,
  saveWorkspaceSnapshot: bridge.saveWorkspaceSnapshot,
  onWindowState: bridge.onWindowState,
  onWorkspaceSnapshotRequested: bridge.onWorkspaceSnapshotRequested,
  onUpdateStatus: bridge.onUpdateStatus,
  getCodexCliUpdateStatus: bridge.getCodexCliUpdateStatus,
  checkCodexCliUpdates: bridge.checkCodexCliUpdates,
  updateCodexCli: bridge.updateCodexCli,
  onCodexCliUpdateStatus: bridge.onCodexCliUpdateStatus,
  getClaudeRuntimeStatus: bridge.getClaudeRuntimeStatus,
  checkClaudeCodeUpdates: bridge.checkClaudeCodeUpdates,
  updateClaudeCode: bridge.updateClaudeCode,
  onClaudeRuntimeStatus: bridge.onClaudeRuntimeStatus,
  ...(process.env.ELECTRON_RENDERER_URL ? {
    dev: {
      holdClaudeWorkerRequests() {
        return ipcRenderer.invoke("agentdesk:dev-claude-worker-hold-requests");
      },
      injectClaudeWorkerFatal() {
        return ipcRenderer.invoke("agentdesk:dev-claude-worker-fatal");
      },
      setClaudeLifecycleFixture(kind: "longBash" | "hook" | "mcp" | "userQuestion" | "stream" | "compact" | "incompleteTool" | null) {
        return ipcRenderer.invoke("agentdesk:dev-claude-lifecycle-fixture", kind);
      },
      setDesktopUpdateFixture() {
        return ipcRenderer.invoke("agentdesk:dev-desktop-update-fixture");
      },
      shutdownDryRun() {
        return ipcRenderer.invoke("agentdesk:dev-shutdown-dry-run");
      },
      quitForTesting() {
        return ipcRenderer.invoke("agentdesk:dev-app-quit");
      },
      setClaudeGatewayFixture(kind: "unauthorized" | "rateLimited" | "serverError" | "truncatedSse" | "timeout" | "offline" | null) {
        return ipcRenderer.invoke("agentdesk:dev-claude-gateway-fixture", kind);
      },
      setClaudeSignatureFixture(kind: "official" | "otherSigned" | "unsigned") {
        return ipcRenderer.invoke("agentdesk:dev-claude-signature-fixture", kind);
      },
    },
  } : {}),
};

contextBridge.exposeInMainWorld("agentDesk", agentBridge);
