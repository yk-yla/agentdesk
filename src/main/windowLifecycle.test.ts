import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRendererReloadShortcut, isSafeExternalUrl, isSameRendererLocation, WindowLifecycle, type WindowLifecycleDependencies } from "./windowLifecycle";

function createLifecycle(overrides: Partial<WindowLifecycleDependencies> = {}) {
  const registered = new Set<string>();
  let quitRequests = 0;
  const dependencies: WindowLifecycleDependencies = {
    createWindow: () => { throw new Error("not used"); },
    createTray: () => { throw new Error("not used"); },
    buildMenu: () => ({}),
    shortcuts: {
      register: (accelerator) => { registered.add(accelerator); return true; },
      unregister: (accelerator) => { registered.delete(accelerator); },
      unregisterAll: () => { registered.clear(); },
      isRegistered: (accelerator) => registered.has(accelerator),
    },
    writeBossKey: () => undefined,
    openExternal: async () => undefined,
    publish: () => undefined,
    appPath: () => "C:\\AgentDesk",
    isPackaged: () => false,
    rendererUrl: () => "",
    quitApp: () => { quitRequests += 1; },
    requestSingleInstanceLock: () => true,
    onSecondInstance: () => undefined,
    ...overrides,
  };
  return { lifecycle: new WindowLifecycle(dependencies), registered, quitRequests: () => quitRequests };
}

function nextTask() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe("WindowLifecycle policies", () => {
  it("allows only HTTP(S) external URLs", () => {
    assert.equal(isSafeExternalUrl("https://example.com"), true);
    assert.equal(isSafeExternalUrl("http://example.com"), true);
    assert.equal(isSafeExternalUrl("file:///C:/secret.txt"), false);
    assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  });

  it("distinguishes renderer navigation from same-page query and hash changes", () => {
    assert.equal(isSameRendererLocation("http://localhost:5173/?a=1", "http://localhost:5173/#next"), true);
    assert.equal(isSameRendererLocation("http://localhost:5173/", "https://example.com/"), false);
    assert.equal(isSameRendererLocation("file:///C:/AgentDesk/index.html", "file:///C:/AgentDesk/index.html#next"), true);
  });

  it("blocks renderer reload shortcuts", () => {
    assert.equal(isRendererReloadShortcut({ type: "keyDown", control: false, alt: false, key: "F5" }), true);
    assert.equal(isRendererReloadShortcut({ type: "keyDown", control: true, alt: false, key: "r" }), true);
    assert.equal(isRendererReloadShortcut({ type: "keyUp", control: true, alt: false, key: "r" }), false);
    assert.equal(isRendererReloadShortcut({ type: "keyDown", control: false, alt: false, key: "r" }), false);
  });

  it("creates the tray once and configures its restore actions", () => {
    let createCount = 0;
    let tooltip = "";
    let menuTemplate: Array<Record<string, unknown>> = [];
    const listeners: Record<string, () => void> = {};
    const { lifecycle } = createLifecycle({
      createTray: () => {
        createCount += 1;
        return {
          setToolTip: (value) => { tooltip = value; },
          setContextMenu: () => undefined,
          on: (event, listener) => { listeners[event] = listener; },
        };
      },
      buildMenu: (template) => { menuTemplate = template; return {}; },
    });

    lifecycle.createTray();
    lifecycle.createTray();

    assert.equal(createCount, 1);
    assert.equal(tooltip, "AgentDesk");
    assert.deepEqual(Object.keys(listeners).sort(), ["click", "double-click"]);
    assert.equal(menuTemplate.some((item) => item.label === "打开 AgentDesk"), true);
    assert.equal(menuTemplate.some((item) => item.label === "退出"), true);
  });

  it("rejects a second primary instance and forwards accepted second-instance arguments", () => {
    const rejected = createLifecycle({ requestSingleInstanceLock: () => false });
    assert.equal(rejected.lifecycle.acquireSingleInstance(() => undefined), false);
    assert.equal(rejected.quitRequests(), 1);

    let secondInstanceListener: ((argv: string[]) => void) | undefined;
    let received: string[] = [];
    const accepted = createLifecycle({
      onSecondInstance: (listener) => { secondInstanceListener = listener; },
    });
    assert.equal(accepted.lifecycle.acquireSingleInstance((argv) => { received = argv; }), true);
    secondInstanceListener?.(["AgentDesk.exe", "--cwd", "C:\\workspace"]);
    assert.deepEqual(received, ["AgentDesk.exe", "--cwd", "C:\\workspace"]);
    assert.equal(accepted.quitRequests(), 0);
  });

  it("allows quit only after backend shutdown succeeds", async () => {
    const { lifecycle, quitRequests } = createLifecycle();
    let prevented = 0;
    let disposed = 0;
    lifecycle.handleBeforeQuit(
      { preventDefault: () => { prevented += 1; } },
      async () => undefined,
      () => { disposed += 1; },
    );
    await nextTask();

    assert.equal(prevented, 1);
    assert.equal(disposed, 1);
    assert.equal(lifecycle.allowQuit, true);
    assert.equal(quitRequests(), 1);
  });

  it("returns to a usable state when backend shutdown fails", async () => {
    const messages: unknown[] = [];
    const { lifecycle, quitRequests } = createLifecycle({ publish: (message) => messages.push(message) });
    lifecycle.handleBeforeQuit(
      { preventDefault: () => undefined },
      async () => { throw new Error("close failed"); },
      () => undefined,
    );
    await nextTask();

    assert.equal(lifecycle.isQuitting, false);
    assert.equal(lifecycle.allowQuit, false);
    assert.equal(quitRequests(), 0);
    assert.match(JSON.stringify(messages), /close failed/);
  });

  it("keeps the previous boss key when persistence fails", async () => {
    const { lifecycle, registered } = createLifecycle({
      writeBossKey: (accelerator) => {
        if (accelerator === "Alt+Q") throw new Error("write failed");
      },
    });
    lifecycle.registerBossKey("F2");
    await assert.rejects(() => lifecycle.changeBossKey("Alt+Q"), /write failed/);
    assert.equal(registered.has("F2"), true);
    assert.equal(registered.has("Alt+Q"), false);
  });
});
