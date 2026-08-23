import path from "node:path";
import type { DesktopWindowState, JsonRpcMessage } from "../shared/protocol";

interface EventWithPreventDefault {
  preventDefault(): void;
}

interface WindowWebContents {
  send(channel: string, payload: unknown): void;
  getURL(): string;
  reload(): void;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
  on(event: "will-navigate", listener: (event: EventWithPreventDefault, url: string) => void): void;
  on(event: "before-input-event", listener: (event: EventWithPreventDefault, input: RendererKeyInput) => void): void;
}

interface RendererKeyInput {
  type: string;
  control: boolean;
  alt: boolean;
  key: string;
}

export interface DesktopWindow {
  webContents: WindowWebContents;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isMaximized(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  restore(): void;
  show(): void;
  hide(): void;
  focus(): void;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  loadURL(url: string): Promise<void>;
  loadFile(filePath: string): Promise<void>;
  once(event: "ready-to-show", listener: () => void): void;
  on(event: "close", listener: (event: EventWithPreventDefault) => void): void;
  on(event: "maximize" | "unmaximize" | "minimize" | "restore" | "show" | "hide" | "focus" | "blur" | "unresponsive" | "responsive" | "closed", listener: () => void): void;
}

interface DesktopTray {
  setToolTip(value: string): void;
  setContextMenu(menu: unknown): void;
  on(event: "click" | "double-click", listener: () => void): void;
}

export interface WindowLifecycleDependencies {
  createWindow(options: Record<string, unknown>): DesktopWindow;
  createTray(iconPath: string): DesktopTray;
  buildMenu(template: Array<Record<string, unknown>>): unknown;
  openExternal(url: string): Promise<unknown>;
  publish(message: JsonRpcMessage): void;
  appPath(): string;
  isPackaged(): boolean;
  rendererUrl(): string;
  quitApp(): void;
  requestSingleInstanceLock(): boolean;
  onSecondInstance(listener: (argv: string[]) => void): void;
  now?: () => number;
  log?(level: "info" | "warn", event: string, details?: Record<string, unknown>): void;
}

export function isSafeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function isSameRendererLocation(currentValue: string, nextValue: string) {
  if (!currentValue) return false;
  try {
    const current = new URL(currentValue);
    const next = new URL(nextValue);
    return current.protocol === "file:"
      ? next.protocol === "file:" && next.pathname === current.pathname
      : next.origin === current.origin;
  } catch {
    return false;
  }
}

export function isRendererReloadShortcut(input: RendererKeyInput) {
  if (input.type !== "keyDown") return false;
  const key = input.key.toLowerCase();
  return key === "f5" || (input.control && key === "r");
}

export class WindowLifecycle {
  private window: DesktopWindow | null = null;
  private tray: DesktopTray | null = null;
  private quitting = false;
  private quitAllowed = false;
  constructor(private readonly dependencies: WindowLifecycleDependencies) {}

  get isQuitting() {
    return this.quitting;
  }

  get allowQuit() {
    return this.quitAllowed;
  }

  acquireSingleInstance(onSecondInstance: (argv: string[]) => void) {
    if (!this.dependencies.requestSingleInstanceLock()) {
      this.dependencies.quitApp();
      return false;
    }
    this.dependencies.onSecondInstance((argv) => {
      onSecondInstance(argv);
      this.show();
    });
    return true;
  }

  createWindow() {
    const developmentUrl = this.dependencies.rendererUrl();
    const window = this.dependencies.createWindow({
      frame: false,
      backgroundColor: "#0d0f10",
      icon: this.appIconPath(),
      title: "AgentDesk",
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "../preload/preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = window;

    window.once("ready-to-show", () => {
      if (this.window !== window || window.isDestroyed()) return;
      window.maximize();
      if (!developmentUrl) window.show();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) void this.dependencies.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (isSameRendererLocation(window.webContents.getURL(), url)) return;
      event.preventDefault();
      if (isSafeExternalUrl(url)) void this.dependencies.openExternal(url);
    });
    if (developmentUrl) void window.loadURL(developmentUrl);
    else void window.loadFile(path.join(this.dependencies.appPath(), "build/renderer/index.html"));
    window.webContents.on("before-input-event", (event, input) => {
      if (isRendererReloadShortcut(input)) {
        event.preventDefault();
        return;
      }
      if (input.type === "keyDown" && input.control && !input.alt && input.key.toLowerCase() === "w") {
        event.preventDefault();
        this.dependencies.publish({ method: "client/close-active-tab", params: {} });
      }
    });
    window.on("close", (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.dependencies.log?.("info", "window.close_hidden");
      window.hide();
    });
    window.on("maximize", () => this.emitWindowState());
    window.on("unmaximize", () => this.emitWindowState());
    window.on("minimize", () => this.dependencies.log?.("info", "window.minimized"));
    window.on("restore", () => this.dependencies.log?.("info", "window.restored"));
    window.on("show", () => this.dependencies.log?.("info", "window.shown"));
    window.on("hide", () => this.dependencies.log?.("info", "window.hidden"));
    window.on("focus", () => this.dependencies.log?.("info", "window.focused"));
    window.on("blur", () => this.dependencies.log?.("info", "window.blurred"));
    window.on("unresponsive", () => this.dependencies.log?.("warn", "window.unresponsive"));
    window.on("responsive", () => this.dependencies.log?.("info", "window.responsive"));
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });
    return window;
  }

  createTray() {
    if (this.tray) return;
    const tray = this.dependencies.createTray(this.appIconPath());
    this.tray = tray;
    tray.setToolTip("AgentDesk");
    tray.setContextMenu(this.dependencies.buildMenu([
      { label: "打开 AgentDesk", click: () => this.show() },
      { type: "separator" },
      { label: "退出", click: () => this.requestQuit() },
    ]));
    tray.on("click", () => this.show());
    tray.on("double-click", () => this.show());
  }

  show() {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    this.dependencies.log?.("info", "window.show_requested", { minimized: window.isMinimized(), visible: window.isVisible(), focused: window.isFocused() });
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  send(channel: string, payload: unknown) {
    if (!this.window || this.window.isDestroyed()) return false;
    this.window.webContents.send(channel, payload);
    return true;
  }

  reloadRenderer(webContents: unknown) {
    if (!this.isCurrentRenderer(webContents)) return false;
    this.window?.webContents.reload();
    return true;
  }

  isCurrentRenderer(webContents: unknown) {
    const window = this.window;
    return Boolean(!this.quitting && window && !window.isDestroyed() && window.webContents === webContents);
  }

  currentState(): DesktopWindowState {
    return { maximized: Boolean(this.window && !this.window.isDestroyed() && this.window.isMaximized()) };
  }

  minimize() {
    this.dependencies.log?.("info", "window.minimize_requested");
    this.window?.minimize();
  }

  toggleMaximize() {
    const window = this.window;
    if (!window || window.isDestroyed()) return this.currentState();
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    this.dependencies.log?.("info", "window.maximize_toggled", { maximized: window.isMaximized() });
    return this.currentState();
  }

  requestQuit() {
    this.quitting = true;
    this.dependencies.quitApp();
  }

  async prepareInstall(closeBackends: () => Promise<void>) {
    if (this.quitting) throw new Error("后台服务正在关闭，请稍候。");
    this.quitting = true;
    try {
      await closeBackends();
      this.quitAllowed = true;
    } catch (error) {
      this.quitting = false;
      this.quitAllowed = false;
      throw error;
    }
  }

  async shutdownDryRun(closeBackends: () => Promise<void>) {
    if (this.quitting) return { ok: true };
    this.quitting = true;
    try {
      await closeBackends();
      return { ok: true };
    } catch (error) {
      this.quitting = false;
      throw error;
    }
  }

  handleBeforeQuit(event: EventWithPreventDefault, closeBackends: () => Promise<void>, dispose: () => void) {
    this.quitting = true;
    if (this.quitAllowed) {
      dispose();
      return;
    }
    event.preventDefault();
    void closeBackends().then(() => {
      dispose();
      this.quitAllowed = true;
      this.dependencies.quitApp();
    }).catch((error) => {
      this.quitting = false;
      this.quitAllowed = false;
      this.dependencies.publish({ method: "client/error", params: { message: error instanceof Error ? error.message : "关闭后台服务失败。" } });
    });
  }

  private emitWindowState() {
    this.send("agentdesk:window-state-changed", this.currentState());
  }

  private appIconPath() {
    return this.dependencies.isPackaged()
      ? path.join(this.dependencies.appPath(), "build/renderer/app-icon.png")
      : path.join(this.dependencies.appPath(), "src/renderer/public/app-icon.png");
  }
}
