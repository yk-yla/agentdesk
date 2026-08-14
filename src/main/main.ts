import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, Notification, safeStorage, shell, Tray, type NotificationConstructorOptions } from "electron";
import { autoUpdater } from "electron-updater";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, promises as fsPromises, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { CodexDefaults, HandoffPackage, JsonRpcMessage, SavedImage, SavedTextFile } from "../shared/protocol";
import { createBackendRegistry } from "./agent/backendRegistry";
import { prepareAgentRequest } from "./agent/requestAdapterRegistry";
import { writeTextFileAtomicAsync } from "./atomicFile";
import { DesktopNotificationRetention, normalizeDesktopNotification } from "./desktopNotification";
import { CoalescingAsyncTask } from "./asyncOperation";
import { canonicalPath, isWithinDirectory, resolveLocalPathOpenRequest } from "./localPathPolicy";
import { CodexBackend } from "./providers/codex/CodexBackend";
import { CodexAppServer } from "./providers/codex/codexAppServer";
import { ClaudeBackend } from "./providers/claude/ClaudeBackend";
import type { ClaudeGatewayFixtureKind, ClaudeLifecycleFixtureKind } from "./providers/claude/claudeWorkerProtocol";
import { prepareClaudeTurnParams } from "./providers/claude/claudeImageInput";
import { ClaudeWorkerHost } from "./providers/claude/claudeWorkerHost";
import { readClaudeCredentials } from "./providers/claude/claudeCredentials";
import { managedClaudeExecutablePath } from "./providers/claude/claudeUpdater";
import { resolveExecutableFromPath } from "./executablePath";
import { runShutdownSteps, ShutdownCoordinator } from "./shutdownCoordinator";
import { PreferencesStore } from "./preferencesStore";
import { ProcessSupervisor } from "./processSupervisor";
import { DesktopUpdateManager } from "./desktopUpdateManager";
import { CodexCliUpdateManager } from "./codexCliUpdateManager";
import { ClaudeUpdateManager } from "./claudeUpdateManager";
import { isSafeExternalUrl, WindowLifecycle, type DesktopWindow } from "./windowLifecycle";
import { registerDesktopIpc } from "./ipc/registerDesktopIpc";
import { FileLogger, logErrorDetails } from "./logger";
import { launchWindowsTerminal } from "./windowsTerminal";
import { requestedProviderFromArgs, requestedWorkspaceFromArgs, startupWorkspace } from "./workspaceArgs";
import { WorkspaceAuthorizationRegistry, type WorkspaceAuthorizationSource } from "./workspaceAuthorizationRegistry";
import { WorkspaceGrantStore } from "./workspaceGrantStore";
import { parseClipboardImageDataUrl } from "./clipboardImageData";
import { isClipboardImageSizeAllowed } from "../shared/imagePolicy";
import { WorkspaceSnapshotCoordinator } from "./workspaceSnapshotCoordinator";

const MAX_AUTHORIZED_LOCAL_PATHS = 4_096;
const MAX_AUTHORIZED_WORKSPACE_PATHS = 64;
const MAX_ATTACHMENT_FILES = 10_000;
const MAX_ATTACHMENT_STORAGE_BYTES = 1024 * 1024 * 1024;
const backendShutdownCoordinator = new ShutdownCoordinator(35_000);
let workspacePath = resolveWorkspace(process.argv);
let claudeGatewayFixture: { kind: ClaudeGatewayFixtureKind; baseUrl: string; timeoutMs?: number } | null = null;
let claudeGatewayFixtureServer: Server | null = null;
let claudeLifecycleFixture: ClaudeLifecycleFixtureKind | null = null;
const attachmentCleanupTask = new CoalescingAsyncTask();
const processSupervisor = new ProcessSupervisor();
let codexCliUpdateManager: CodexCliUpdateManager;
let claudeUpdateManager: ClaudeUpdateManager;

const EMPTY_CODEX_DEFAULTS: CodexDefaults = { model: "", effort: "" };

function codexConfigPath() {
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  return path.join(codexHome, "config.toml");
}

function readCodexDefaults(): CodexDefaults {
  try {
    const parsed = parseToml(readFileSync(codexConfigPath(), "utf8")) as Record<string, unknown>;
    return {
      model: typeof parsed.model === "string" ? parsed.model : "",
      effort: typeof parsed.model_reasoning_effort === "string" ? parsed.model_reasoning_effort : "",
    };
  } catch {
    return { ...EMPTY_CODEX_DEFAULTS };
  }
}

const preferencesStore = new PreferencesStore(() => path.join(app.getPath("userData"), "preferences.json"));
const workspaceGrantStore = new WorkspaceGrantStore(() => path.join(app.getPath("userData"), "workspace-grants.json"), MAX_AUTHORIZED_WORKSPACE_PATHS);
const appLogger = new FileLogger(() => path.join(app.getPath("userData"), "logs"));
const desktopNotificationRetention = new DesktopNotificationRetention<Notification>();

process.on("uncaughtExceptionMonitor", (error) => appLogger.log("error", "process.uncaught_exception", logErrorDetails(error)));
process.on("unhandledRejection", (reason) => appLogger.log("error", "process.unhandled_rejection", reason instanceof Error ? logErrorDetails(reason) : { reason: String(reason) }));
const windowLifecycle = new WindowLifecycle({
  createWindow: (options) => new BrowserWindow(options) as unknown as DesktopWindow,
  createTray: (iconPath) => new Tray(iconPath),
  buildMenu: (template) => Menu.buildFromTemplate(template as Electron.MenuItemConstructorOptions[]),
  shortcuts: globalShortcut,
  writeBossKey: (accelerator) => preferencesStore.write({ bossKey: accelerator }).then(() => undefined),
  openExternal: (url) => shell.openExternal(url),
  publish: (message) => emitToRenderer(message),
  appPath: () => app.getAppPath(),
  isPackaged: () => app.isPackaged,
  rendererUrl: () => process.env.ELECTRON_RENDERER_URL || "",
  quitApp: () => app.quit(),
  requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
  onSecondInstance: (listener) => { app.on("second-instance", (_event, argv) => listener(argv)); },
});
const workspaceSnapshotCoordinator = new WorkspaceSnapshotCoordinator({
  createRequestId: randomUUID,
  requestFromRenderer: (requestId) => windowLifecycle.send("agentdesk:workspace-snapshot-requested", requestId),
  save: (workspaceState) => preferencesStore.write({ workspaceState }),
});

function showRetainedDesktopNotification(options: NotificationConstructorOptions, onClick?: () => void) {
  if (!Notification.isSupported()) return false;
  let notification: Notification | null = null;
  try {
    notification = new Notification(options);
    const release = () => {
      if (notification) desktopNotificationRetention.release(notification);
    };
    notification.on("click", () => {
      release();
      onClick?.();
    });
    notification.on("failed", (_event, error) => {
      release();
      appLogger.log("warn", "notification.failed", { error });
    });
    notification.on("close", (event) => {
      // Windows may keep a timed-out toast in Action Center. Retain it so a
      // later click still reaches Electron; the bounded retention handles it.
      if (event.reason !== "timedOut") release();
    });
    desktopNotificationRetention.retain(notification);
    notification.show();
    return true;
  } catch (error) {
    if (notification) desktopNotificationRetention.release(notification);
    appLogger.log("warn", "notification.show_failed", logErrorDetails(error));
    return false;
  }
}

function attachmentsPath() {
  const directory = path.join(app.getPath("userData"), "attachments");
  mkdirSync(directory, { recursive: true });
  return directory;
}

const authorizedLocalPaths = new Set<string>();
const authorizedClaudeImagePaths = new Set<string>();
const authorizedClaudeMarketplacePaths = new Set<string>();
const authorizedWorkspacePaths = new WorkspaceAuthorizationRegistry(MAX_AUTHORIZED_WORKSPACE_PATHS);
const pendingWorkspaceAuthorizationRequests = new Map<string, Promise<string>>();
let workspaceAuthorizationGrantQueue = Promise.resolve();

function registerAuthorizedWorkspacePath(directory: string, source: WorkspaceAuthorizationSource = "explicit") {
  if (!existingDirectory(directory)) return;
  const resolved = canonicalPath(directory);
  authorizedWorkspacePaths.register(resolved, source);
}

async function grantAuthorizedWorkspacePath(directory: string) {
  if (!existingDirectory(directory)) throw new Error("工作区不存在。");
  const resolved = canonicalPath(directory);
  await workspaceGrantStore.grant(resolved);
  authorizedWorkspacePaths.register(resolved, "explicit");
  return resolved;
}

function isAuthorizedWorkspacePath(directory: string) {
  const resolved = canonicalPath(directory);
  return authorizedWorkspacePaths.paths().some((authorized) => isWithinDirectory(resolved, authorized));
}

function requireAuthorizedWorkspacePath(directory: string) {
  const resolved = canonicalPath(directory);
  if (!existingDirectory(resolved)) throw new Error("工作区不存在。");
  if (!isAuthorizedWorkspacePath(resolved)) throw new Error("该工作区未获得授权。");
  return resolved;
}

function registerAuthorizedLocalPath(filePath: string) {
  if (typeof filePath !== "string" || !filePath.trim() || !existsSync(filePath)) return;
  const resolved = canonicalPath(filePath);
  authorizedLocalPaths.delete(resolved);
  authorizedLocalPaths.add(resolved);
  while (authorizedLocalPaths.size > MAX_AUTHORIZED_LOCAL_PATHS) {
    const oldest = authorizedLocalPaths.values().next().value as string | undefined;
    if (!oldest) break;
    authorizedLocalPaths.delete(oldest);
  }
}

function registerAuthorizedClaudeImagePath(filePath: string) {
  if (typeof filePath !== "string" || !filePath.trim() || !existsSync(filePath)) return;
  const resolved = canonicalPath(filePath);
  authorizedClaudeImagePaths.delete(resolved);
  authorizedClaudeImagePaths.add(resolved);
  while (authorizedClaudeImagePaths.size > MAX_AUTHORIZED_LOCAL_PATHS) {
    const oldest = authorizedClaudeImagePaths.values().next().value as string | undefined;
    if (!oldest) break;
    authorizedClaudeImagePaths.delete(oldest);
  }
}

function registerAuthorizedImageReferences(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(registerAuthorizedImageReferences);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if ((type === "localImage" || type === "imageView" || type === "imageGeneration") && typeof record.path === "string") {
    const resolved = canonicalPath(record.path);
    if (isWithinDirectory(resolved, attachmentsPath()) || isAuthorizedWorkspacePath(resolved)) registerAuthorizedLocalPath(resolved);
  }
  if (type === "imageGeneration" && typeof record.savedPath === "string") {
    const resolved = canonicalPath(record.savedPath);
    if (isWithinDirectory(resolved, attachmentsPath()) || isAuthorizedWorkspacePath(resolved)) registerAuthorizedLocalPath(resolved);
  }
  Object.values(record).forEach(registerAuthorizedImageReferences);
}

function registerAuthorizedClaudeMarketplacePath(directory: string) {
  if (!existingDirectory(directory)) return;
  const resolved = canonicalPath(directory);
  authorizedClaudeMarketplacePaths.delete(resolved);
  authorizedClaudeMarketplacePaths.add(resolved);
  while (authorizedClaudeMarketplacePaths.size > MAX_AUTHORIZED_WORKSPACE_PATHS) {
    const oldest = authorizedClaudeMarketplacePaths.values().next().value as string | undefined;
    if (!oldest) break;
    authorizedClaudeMarketplacePaths.delete(oldest);
  }
}

function isAllowedLocalPath(filePath: string) {
  const resolved = canonicalPath(filePath);
  return isWithinDirectory(resolved, attachmentsPath())
    || authorizedWorkspacePaths.paths().some((directory) => isWithinDirectory(resolved, directory))
    || authorizedLocalPaths.has(resolved);
}

async function closeAllBackendsForExit() {
  appLogger.log("info", "app.shutdown.started");
  return backendShutdownCoordinator.run(async () => {
    try {
      try {
        const snapshotResult = await workspaceSnapshotCoordinator.request();
        if (snapshotResult !== "saved") appLogger.log("warn", "app.workspace_snapshot.fallback", { reason: snapshotResult });
      } catch (error) {
        appLogger.log("warn", "app.workspace_snapshot.failed", logErrorDetails(error));
      }
      await runShutdownSteps([
        { name: "Provider", run: () => backendManager.close() },
        { name: "已跟踪进程", run: () => processSupervisor.terminateAll() },
        { name: "Claude 网关夹具", run: () => closeClaudeGatewayFixture() },
      ]);
      appLogger.log("info", "app.shutdown.completed");
    } catch (error) {
      appLogger.log("error", "app.shutdown.failed", logErrorDetails(error));
      throw error;
    } finally {
      await appLogger.flush();
    }
  });
}

const desktopUpdateManager = new DesktopUpdateManager({
  updater: autoUpdater,
  storage: safeStorage,
  currentVersion: () => app.getVersion(),
  isPackaged: () => app.isPackaged,
  userDataPath: () => app.getPath("userData"),
  emitStatus: (status) => windowLifecycle.send("agentdesk:update-status-changed", status),
  prepareInstall: () => windowLifecycle.prepareInstall(closeAllBackendsForExit),
  scheduleInstall: (install) => setTimeout(install, 100),
});

function rememberWorkspace(directory: string) {
  return preferencesStore.write({ lastWorkspace: path.resolve(directory) });
}

async function registerWorkspace(cwdValue: unknown) {
  if (typeof cwdValue !== "string") throw new Error("工作区无效。");
  const cwd = canonicalPath(cwdValue);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error("工作区不存在。");
  if (isAuthorizedWorkspacePath(cwd)) return cwd;
  const pending = pendingWorkspaceAuthorizationRequests.get(cwd);
  if (pending) return pending;
  const request = workspaceAuthorizationGrantQueue.then(async () => {
    if (isAuthorizedWorkspacePath(cwd)) return cwd;
    return grantAuthorizedWorkspacePath(cwd);
  });
  workspaceAuthorizationGrantQueue = request.then(() => undefined, () => undefined);
  pendingWorkspaceAuthorizationRequests.set(cwd, request);
  try {
    return await request;
  } finally {
    if (pendingWorkspaceAuthorizationRequests.get(cwd) === request) pendingWorkspaceAuthorizationRequests.delete(cwd);
  }
}

async function closeClaudeGatewayFixture() {
  const server = claudeGatewayFixtureServer;
  claudeGatewayFixtureServer = null;
  claudeGatewayFixture = null;
  claudeLifecycleFixture = null;
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function setClaudeGatewayFixture(kind: ClaudeGatewayFixtureKind) {
  await closeClaudeGatewayFixture();
  const server = createServer((_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-should-retry", "false");
    if (kind === "unauthorized") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "C22 fixture unauthorized" } }));
      return;
    }
    if (kind === "rateLimited") {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "C22 fixture rate limited" } }));
      return;
    }
    if (kind === "serverError") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "C22 fixture service unavailable" } }));
      return;
    }
    if (kind === "truncatedSse") {
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_c22_fixture", type: "message", role: "assistant", content: [], model: "claude-fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`);
      response.write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":");
      response.destroy();
      return;
    }
    // The SDK timeout is shortened only for this development fixture.
    if (kind === "timeout") return;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "unexpected fixture request" } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("无法创建 Claude 网关验收端点。" );
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  if (kind === "offline") {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } else {
    claudeGatewayFixtureServer = server;
  }
  claudeGatewayFixture = { kind, baseUrl, ...(kind === "timeout" ? { timeoutMs: 1_500 } : {}) };
  return { kind, baseUrl };
}

function readClaudeCredentialsForQuery() {
  if (!claudeGatewayFixture && !claudeLifecycleFixture) return readClaudeCredentials();
  if (claudeLifecycleFixture) return { source: "process" as const, baseUrl: "http://127.0.0.1", authToken: "agentdesk-lifecycle-fixture-token" };
  const fixture = claudeGatewayFixture;
  if (!fixture) throw new Error("Claude 网关夹具未启动。");
  return { source: "process" as const, baseUrl: fixture.baseUrl, authToken: "agentdesk-c22-fixture-token" };
}

function imageMimeForPath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  const mimeByExtension: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
  return mimeByExtension[extension] ?? null;
}

function dataUrlForImage(filePath: string): string | null {
  const mime = imageMimeForPath(filePath);
  if (!mime || !existsSync(filePath)) return null;
  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size > 10 * 1024 * 1024) return null;
  return `data:${mime};base64,${readFileSync(filePath).toString("base64")}`;
}

function saveClipboardImage(dataUrl: string, suggestedName?: string): SavedImage {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!match) throw new Error("只支持 PNG、JPEG、GIF 或 WebP 图片。");
  const payload = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (payload.length === 0 || payload.length > 10 * 1024 * 1024) throw new Error("图片大小必须在 10 MB 以内。");
  const extension = match[1].split("/")[1].replace("jpeg", "jpg");
  const safeStem = (suggestedName || "pasted-image").replace(/[^a-z0-9_-]/gi, "-").slice(0, 40) || "pasted-image";
  const filePath = path.join(attachmentsPath(), `${Date.now()}-${randomUUID()}-${safeStem}.${extension}`);
  writeFileSync(filePath, payload);
  registerAuthorizedLocalPath(filePath);
  registerAuthorizedClaudeImagePath(filePath);
  scheduleAttachmentCleanup();
  return { path: filePath, dataUrl: `data:${match[1]};base64,${payload.toString("base64")}`, name: path.basename(filePath) };
}

function copyImageToClipboard(dataUrl: string) {
  const parsed = parseClipboardImageDataUrl(dataUrl);
  const image = nativeImage.createFromBuffer(parsed.data);
  if (image.isEmpty()) throw new Error("无法读取待复制图片。");
  const size = image.getSize();
  if (!isClipboardImageSizeAllowed(size.width, size.height)) throw new Error("待复制图片尺寸校验失败。");
  clipboard.writeImage(image);
}

function scheduleAttachmentCleanup() {
  const directory = attachmentsPath();
  void attachmentCleanupTask.request(async () => {
    const entries = await fsPromises.readdir(directory, { withFileTypes: true });
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(directory, entry.name);
      try {
        const stats = await fsPromises.stat(filePath);
        files.push({ path: filePath, size: stats.size, mtimeMs: stats.mtimeMs });
      } catch {
        // 文件可能已被其它清理流程移除。
      }
    }
    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let totalBytes = files.reduce((total, file) => total + file.size, 0);
    let remainingFiles = files.length;
    for (const file of files) {
      if (remainingFiles <= MAX_ATTACHMENT_FILES && totalBytes <= MAX_ATTACHMENT_STORAGE_BYTES) break;
      try {
        await fsPromises.unlink(file.path);
        authorizedLocalPaths.delete(canonicalPath(file.path));
        remainingFiles -= 1;
        totalBytes -= file.size;
      } catch {
        // 清理失败不影响当前附件保存。
      }
    }
  }).catch(() => undefined);
}

function safeFileStem(value: string, fallback: string) {
  const stem = value.replace(/[^a-z0-9_\-\u4e00-\u9fff ]/gi, "-").trim().replace(/\s+/g, "-").slice(0, 80);
  return stem || fallback;
}

function runLocalCommand(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, windowsHide: true, shell: false, encoding: "utf8", timeout: 5_000 });
  const output = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const error = typeof result.stderr === "string" ? result.stderr.trim() : "";
  return { ok: result.status === 0, output: result.status === 0 ? output : (error || output || "命令执行失败") };
}

function openWindowsTerminal(cwd: string) {
  if (process.platform !== "win32") throw new Error("Windows Terminal 仅支持 Windows。" );
  const resolved = requireAuthorizedWorkspacePath(cwd);
  launchWindowsTerminal(resolved);
}

function collectHandoffGitState(cwd: string) {
  const root = runLocalCommand("git", ["rev-parse", "--show-toplevel"], cwd);
  if (!root.ok) return "当前目录未检测到 Git 仓库，或 git 命令不可用。";
  const output = (args: string[], fallback: string) => {
    const result = runLocalCommand("git", args, cwd);
    return result.ok ? result.output || fallback : result.output;
  };
  return [
    `Git 根目录：${root.output}`,
    `当前分支：${output(["branch", "--show-current"], "未确认")}`,
    "",
    "工作区状态：",
    output(["status", "--short", "--branch"], "工作区干净"),
    "",
    "未暂存 Diff 统计：",
    output(["diff", "--stat"], "无未暂存 Diff"),
    "",
    "已暂存 Diff 统计：",
    output(["diff", "--cached", "--stat"], "无已暂存 Diff"),
    "",
    "最近提交：",
    output(["log", "--oneline", "-5"], "未读取到提交记录"),
  ].join("\n");
}

async function saveTextFile(content: string, suggestedName?: string): Promise<SavedTextFile | null> {
  if (typeof content !== "string" || content.length > 20 * 1024 * 1024) throw new Error("导出内容过大。");
  const defaultName = `${safeFileStem(suggestedName || "codex-session", "codex-session")}.md`;
  const result = await dialog.showSaveDialog({
    title: "导出会话 Markdown",
    defaultPath: path.join(workspacePath, defaultName),
    filters: [{ name: "Markdown 文档", extensions: ["md"] }, { name: "文本文件", extensions: ["txt"] }],
  });
  if (result.canceled || !result.filePath) return null;
  const target = path.resolve(result.filePath);
  writeFileSync(target, content, "utf8");
  registerAuthorizedLocalPath(target);
  return { path: target };
}

async function createHandoffPackage(input: { cwd: string; title: string; threadId: string; content: string }): Promise<HandoffPackage> {
  if (!input || typeof input.cwd !== "string" || typeof input.content !== "string") throw new Error("交接参数无效。");
  const cwd = requireAuthorizedWorkspacePath(input.cwd);
  if (input.content.length > 20 * 1024 * 1024) throw new Error("交接内容过大。");
  const directory = path.join(app.getPath("userData"), "handoffs");
  mkdirSync(directory, { recursive: true });
  const name = `${Date.now()}-${safeFileStem(input.title || "codex-session", "codex-session")}`;
  const filePath = path.join(directory, `${name}.md`);
  const gitState = collectHandoffGitState(cwd);
  const content = [
    input.content.trim(),
    "",
    "## 当前本地状态",
    "",
    `- 目录：\`${cwd}\``,
    "",
    "```text",
    gitState,
    "```",
  ].join("\n");
  await writeTextFileAtomicAsync(filePath, `${content.trim()}\n`);
  registerAuthorizedLocalPath(filePath);
  const prompt = `请先读取交接文件：${filePath}\n\n这是从“${input.title || "Codex 会话"}”交接来的任务。请以当前本地代码和 Git 状态为准，确认任务范围后继续完成未完成事项；不要把交接文件当作项目源码修改。`;
  return { path: filePath, prompt };
}

function existingDirectory(value: string) {
  try {
    return existsSync(value) && statSync(value).isDirectory() ? path.resolve(value) : null;
  } catch {
    return null;
  }
}

function resolveWorkspace(argv: string[]): string {
  const flagIndex = argv.findIndex((value) => value === "--cwd");
  const candidate = flagIndex >= 0 ? argv[flagIndex + 1] : "";
  return (candidate && existingDirectory(candidate)) || existingDirectory(process.cwd()) || app.getPath("home");
}

function requestedWorkspace(argv: string[]): string | null {
  return requestedWorkspaceFromArgs(argv, existingDirectory);
}

function emitToRenderer(message: JsonRpcMessage) {
  codexAppServer.publish(message);
}

function preserveLegacyUserDataDirectory() {
  if (process.argv.some((value) => value === "--user-data-dir" || value.startsWith("--user-data-dir="))) return;
  const current = app.getPath("userData");
  const legacy = path.join(app.getPath("appData"), "Codex Desktop");
  if (!existsSync(current) && existsSync(legacy)) app.setPath("userData", legacy);
}

preserveLegacyUserDataDirectory();

const codexAppServer = new CodexAppServer({
  command: () => process.env.CODEX_DESKTOP_CLI?.trim() || (process.platform === "win32" ? "codex.cmd" : "codex"),
  cwd: () => workspacePath,
  appVersion: () => app.getVersion(),
  isRequestBlocked: () => codexCliUpdateManager?.active || false,
  isQuitting: () => windowLifecycle.isQuitting,
  isExitNotificationSuppressed: () => codexCliUpdateManager?.exitNotificationSuppressed || false,
  terminateTree: (child) => processSupervisor.terminate(child),
  logger: appLogger,
  inspectMessage(message, requestMethod) {
    registerAuthorizedImageReferences(message);
  },
});

function claudeWorkerPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "build", "electron", "main", "providers", "claude", "claudeWorker.mjs")
    : path.join(__dirname, "providers", "claude", "claudeWorker.mjs");
}

const claudeWorkerHost = new ClaudeWorkerHost(claudeWorkerPath, {
  reportCleanupFailure: (message) => appLogger.log("error", "claude.worker.cleanup_failed", { message }),
});
let claudeBackend: ClaudeBackend;
const backendManager = createBackendRegistry([new CodexBackend(codexAppServer), (claudeBackend = new ClaudeBackend(claudeWorkerHost, undefined, readClaudeCredentialsForQuery, () => claudeGatewayFixture || claudeLifecycleFixture ? { kind: claudeGatewayFixture?.kind || "offline", ...(claudeGatewayFixture?.timeoutMs ? { timeoutMs: claudeGatewayFixture.timeoutMs } : {}), ...(claudeLifecycleFixture ? { lifecycle: claudeLifecycleFixture } : {}) } : undefined, undefined, (directory) => authorizedClaudeMarketplacePaths.has(canonicalPath(directory))))], appLogger, (cwd) => isAuthorizedWorkspacePath(cwd));

claudeUpdateManager = new ClaudeUpdateManager({
  appPath: () => app.getAppPath(),
  userDataPath: () => app.getPath("userData"),
  fetch: (url, init) => net.fetch(url, init),
  shutdownQueries: () => claudeBackend.shutdownQueries(),
  emitStatus: (status) => windowLifecycle.send("claude:runtime-status-changed", status),
});

codexCliUpdateManager = new CodexCliUpdateManager({
  processSupervisor,
  appServer: codexAppServer,
  userDataPath: () => app.getPath("userData"),
  isQuitting: () => windowLifecycle.isQuitting,
  emitStatus: (status) => windowLifecycle.send("agentdesk:cli-update-status-changed", status),
  notify: (title, body) => {
    showRetainedDesktopNotification({ title, body }, () => windowLifecycle.show());
  },
});

backendManager.subscribeEvents((event) => windowLifecycle.send("agent:event", event));

const hasLock = windowLifecycle.acquireSingleInstance((argv) => {
  appLogger.log("info", "app.second_instance", { argv });
  const nextWorkspace = requestedWorkspace(argv);
  const nextProvider = requestedProviderFromArgs(argv);
  if (nextWorkspace) {
    void grantAuthorizedWorkspacePath(nextWorkspace).then(async () => {
      await rememberWorkspace(nextWorkspace);
      emitToRenderer({ method: "client/open-workspace", params: { workspace: nextWorkspace, ...(nextProvider ? { provider: nextProvider } : {}) } });
    }).catch((error) => appLogger.log("error", "workspace.second_instance_failed", logErrorDetails(error)));
  }
});
if (hasLock) {
  app.whenReady().then(async () => {
    appLogger.log("info", "app.started", { version: app.getVersion(), packaged: app.isPackaged, argv: process.argv });
    const explicitWorkspace = requestedWorkspace(process.argv);
    const startupPreferences = preferencesStore.read();
    authorizedWorkspacePaths.clear();
    workspaceGrantStore.read().reverse().forEach((directory) => registerAuthorizedWorkspacePath(directory));
    const savedWorkspace = existingDirectory(startupPreferences.lastWorkspace);
    const authorizedSavedWorkspace = savedWorkspace && isAuthorizedWorkspacePath(savedWorkspace) ? savedWorkspace : null;
    workspacePath = startupWorkspace(explicitWorkspace, authorizedSavedWorkspace, workspacePath);
    await grantAuthorizedWorkspacePath(workspacePath);
    await rememberWorkspace(workspacePath);
    appLogger.log("info", "workspace.selected", { workspace: workspacePath, explicit: Boolean(explicitWorkspace), restored: false });
    registerDesktopIpc(ipcMain, {
      logger: appLogger,
      workspace: {
        current: () => workspacePath,
        launchProvider: () => requestedProviderFromArgs(process.argv),
        choose: async (defaultPath) => {
          const result = await dialog.showOpenDialog({ properties: ["openDirectory"], defaultPath: defaultPath || workspacePath });
          if (result.canceled || !result.filePaths[0]) return null;
          const selected = path.resolve(result.filePaths[0]);
          await grantAuthorizedWorkspacePath(selected);
          await rememberWorkspace(selected);
          return selected;
        },
        register: registerWorkspace,
      },
      preferences: preferencesStore,
      workspaceSnapshot: {
        complete: (requestId, workspaceState) => workspaceSnapshotCoordinator.complete(requestId, workspaceState),
      },
      bossKey: {
        status: () => windowLifecycle.bossKeyState(),
        change: (accelerator) => windowLifecycle.changeBossKey(accelerator),
      },
      codexDefaults: () => readCodexDefaults(),
      files: {
        saveClipboardImage: (input) => {
          if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as { dataUrl?: unknown }).dataUrl !== "string") throw new Error("剪贴板图片无效。");
          const value = input as { dataUrl: string; suggestedName?: unknown };
          return saveClipboardImage(value.dataUrl, typeof value.suggestedName === "string" ? value.suggestedName : undefined);
        },
        copyImage: (dataUrl) => {
          if (typeof dataUrl !== "string") throw new Error("待复制图片无效。");
          copyImageToClipboard(dataUrl);
        },
        saveTextFile: (input) => {
          if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as { content?: unknown }).content !== "string") throw new Error("导出内容无效。");
          const value = input as { content: string; suggestedName?: unknown };
          return saveTextFile(value.content, typeof value.suggestedName === "string" ? value.suggestedName : undefined);
        },
        createHandoff: (input) => {
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("交接参数无效。");
          const value = input as Record<string, unknown>;
          if (typeof value.cwd !== "string" || typeof value.title !== "string" || typeof value.threadId !== "string" || typeof value.content !== "string") throw new Error("交接参数无效。");
          return createHandoffPackage({ cwd: value.cwd, title: value.title, threadId: value.threadId, content: value.content });
        },
        chooseClaudeMarketplaceDirectory: async (defaultPath) => {
          const initial = typeof defaultPath === "string" && existingDirectory(defaultPath) ? defaultPath : workspacePath;
          const result = await dialog.showOpenDialog({ properties: ["openDirectory"], defaultPath: initial });
          if (result.canceled || !result.filePaths[0]) return null;
          const selected = canonicalPath(result.filePaths[0]);
          registerAuthorizedClaudeMarketplacePath(selected);
          return selected;
        },
        openTerminal: (cwd) => {
          if (typeof cwd !== "string") throw new Error("工作目录无效。");
          return openWindowsTerminal(cwd);
        },
        readLocalImage: (filePath) => {
          if (typeof filePath !== "string") return null;
          const resolved = canonicalPath(filePath);
          if (!isAllowedLocalPath(resolved)) return null;
          const dataUrl = dataUrlForImage(resolved);
          if (dataUrl) {
            registerAuthorizedLocalPath(resolved);
            registerAuthorizedClaudeImagePath(resolved);
          }
          return dataUrl;
        },
        openLocalPath: (input) => {
          const target = resolveLocalPathOpenRequest(input, { isAuthorizedWorkspacePath });
          if (!isAllowedLocalPath(target.path)) registerAuthorizedLocalPath(target.path);
          if (target.revealOnly) {
            shell.showItemInFolder(target.path);
            return "";
          }
          return shell.openPath(target.path);
        },
        openExternal: (url) => {
          if (typeof url !== "string" || !isSafeExternalUrl(url)) throw new Error("只允许打开 HTTP 或 HTTPS 链接。");
          return shell.openExternal(url);
        },
      },
      showNotification: (input) => {
        const normalized = normalizeDesktopNotification(input);
        if (!normalized) return false;
        return showRetainedDesktopNotification({ title: normalized.title, ...(normalized.body ? { body: normalized.body } : {}) }, () => {
          appLogger.log("info", "notification.activated", { sessionId: normalized.sessionId, provider: normalized.provider });
          windowLifecycle.show();
          emitToRenderer({ method: "client/activate-session", params: { sessionId: normalized.sessionId } });
        });
      },
      window: {
        state: () => windowLifecycle.currentState(),
        minimize: () => windowLifecycle.minimize(),
        toggleMaximize: () => windowLifecycle.toggleMaximize(),
      },
      desktopUpdate: {
        status: () => desktopUpdateManager.currentStatus(),
        saveToken: (token) => desktopUpdateManager.saveToken(token),
        clearToken: () => desktopUpdateManager.clearToken(),
        check: () => desktopUpdateManager.check(),
        download: () => desktopUpdateManager.download(),
        install: () => desktopUpdateManager.install(),
      },
      codexUpdate: {
        status: () => codexCliUpdateManager.currentStatus(),
        check: () => codexCliUpdateManager.check(true),
        install: () => codexCliUpdateManager.update(),
      },
      claude: {
        status: () => claudeUpdateManager.currentStatus(),
        checkUpdate: () => claudeUpdateManager.check(),
        installUpdate: (allowUnverified) => claudeUpdateManager.update(allowUnverified),
      },
      agent: {
        request: (request) => {
          const params = prepareAgentRequest(request.provider, request.operation, request.params, (input) =>
            prepareClaudeTurnParams(input, attachmentsPath(), authorizedClaudeImagePaths));
          return backendManager.request(request.provider, request.operation, params, request.context);
        },
        respond: (response) => backendManager.respond(response.ref, response.result),
      },
      ...(process.env.ELECTRON_RENDERER_URL ? {
        development: {
          holdClaudeWorkerRequests: () => claudeWorkerHost.holdRequestsForTesting(),
          injectClaudeWorkerFatal: () => claudeWorkerHost.injectFatalForTesting(),
          setClaudeGatewayFixture: (kind: unknown) => {
            if (kind === null) return closeClaudeGatewayFixture().then(() => ({ kind: null }));
            if (kind !== "unauthorized" && kind !== "rateLimited" && kind !== "serverError" && kind !== "truncatedSse" && kind !== "timeout" && kind !== "offline") throw new Error("Claude 网关验收类型无效。");
            return setClaudeGatewayFixture(kind);
          },
          setClaudeLifecycleFixture: (kind: unknown) => {
            if (kind === null) return closeClaudeGatewayFixture().then(() => ({ kind: null }));
            if (kind !== "longBash" && kind !== "hook" && kind !== "mcp" && kind !== "userQuestion" && kind !== "stream" && kind !== "compact" && kind !== "incompleteTool") throw new Error("Claude 生命周期夹具类型无效。");
            claudeLifecycleFixture = kind;
            return { kind };
          },
          setDesktopUpdateFixture: () => desktopUpdateManager.setStatus({ phase: "downloaded", availableVersion: app.getVersion(), progress: undefined, message: "C-03 桌面更新关闭流程夹具，未下载真实安装包。" }),
          shutdownDryRun: () => windowLifecycle.shutdownDryRun(closeAllBackendsForExit),
          quitApp: () => {
            setImmediate(() => app.quit());
            return { requested: true };
          },
          setClaudeSignatureFixture: (kind: unknown) => {
            if (kind !== "official" && kind !== "otherSigned" && kind !== "unsigned") throw new Error("Claude 签名样本无效。");
            const executable = kind === "official"
              ? managedClaudeExecutablePath()
              : kind === "otherSigned"
                ? resolveExecutableFromPath("notepad.exe")
                : path.join(app.getAppPath(), "node_modules", "electron", "dist", "electron.exe");
            if (!executable) throw new Error("PATH 中未找到 notepad.exe 测试样本。");
            return claudeUpdateManager.setSignatureFixture(executable);
          },
        },
      } : {}),
    });
    windowLifecycle.createWindow();
    windowLifecycle.registerBossKey(startupPreferences.bossKey);
    windowLifecycle.createTray();
    void codexCliUpdateManager.initialize();
  });
}

app.on("before-quit", (event) => windowLifecycle.handleBeforeQuit(event, closeAllBackendsForExit, () => codexCliUpdateManager.dispose()));

let rendererRecoveryInFlight = false;
app.on("render-process-gone", (_event, webContents, details) => {
  appLogger.log("error", "electron.render_process_gone", { webContentsId: webContents.id, details });
  if (details.reason === "clean-exit" || rendererRecoveryInFlight || !windowLifecycle.isCurrentRenderer(webContents)) return;
  rendererRecoveryInFlight = true;
  const reset = backendManager.resetRendererSessions().then(() => "reset" as const).catch((error) => {
    appLogger.log("error", "electron.renderer_session_reset_failed", logErrorDetails(error));
    return "failed" as const;
  });
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => { recoveryTimer = setTimeout(() => resolve("timeout"), 5_000); });
  void Promise.race([reset, timeout]).then((result) => {
    if (result === "timeout") appLogger.log("warn", "electron.renderer_session_reset_timeout");
  }).finally(() => {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    rendererRecoveryInFlight = false;
    if (windowLifecycle.reloadRenderer(webContents)) appLogger.log("info", "electron.renderer_reloaded", { webContentsId: webContents.id });
  });
});

app.on("child-process-gone", (_event, details) => {
  appLogger.log("error", "electron.child_process_gone", { details });
});

app.on("will-quit", () => {
  windowLifecycle.dispose();
});

