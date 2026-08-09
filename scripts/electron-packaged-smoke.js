async page => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  await page.locator("aside.sidebar").waitFor({ state: "visible", timeout: 15_000 });
  const runtime = await page.evaluate(async () => ({
    url: location.href,
    userAgent: navigator.userAgent,
    hasBridge: Boolean(window.agentDesk),
    hasDevBridge: Boolean(window.agentDesk?.dev),
    hasRendererRequire: typeof window.require !== "undefined",
    hasRendererProcess: typeof window.process !== "undefined",
    windowState: await window.agentDesk.getWindowState(),
  }));
  assert(runtime.url.startsWith("file:"), `打包版没有加载本地产物：${runtime.url}`);
  assert(/Electron\/43\.3\.0\b/.test(runtime.userAgent), `打包版 Electron 版本不正确：${runtime.userAgent}`);
  assert(runtime.hasBridge && !runtime.hasDevBridge, "打包版 Bridge 或开发夹具暴露状态不正确。");
  assert(!runtime.hasRendererRequire && !runtime.hasRendererProcess, "打包版 Renderer 暴露了 Node 全局对象。");
  assert(runtime.windowState.maximized, "打包版主窗口启动后没有最大化。");

  const windowStates = await page.evaluate(async () => {
    const restored = await window.agentDesk.toggleMaximizeWindow();
    const maximized = await window.agentDesk.toggleMaximizeWindow();
    return { restored, maximized };
  });
  assert(!windowStates.restored.maximized && windowStates.maximized.maximized, "打包版最大化切换 IPC 状态不正确。");

  const input = page.locator('.pane-panel textarea[aria-label="消息输入"]');
  await input.waitFor({ state: "visible", timeout: 15_000 });
  const pointerStyle = await input.evaluate((element) => {
    const style = getComputedStyle(element);
    return { cursor: style.cursor, caretColor: style.caretColor };
  });
  assert(pointerStyle.cursor === "default", `打包版输入框鼠标仍可能不可见：${pointerStyle.cursor}`);
  assert(pointerStyle.caretColor !== "rgba(0, 0, 0, 0)", "打包版输入框文字插入光标是透明的。");

  const desktopIpc = await page.evaluate(async () => {
    const savedImage = await window.agentDesk.saveClipboardImage(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "package-smoke",
    );
    const readImage = await window.agentDesk.readLocalImage(savedImage.path);
    let unsafeExternalRejected = false;
    try {
      await window.agentDesk.openExternal("javascript:alert(1)");
    } catch {
      unsafeExternalRejected = true;
    }
    const invalidNotificationAccepted = await window.agentDesk.showNotification({
      sessionId: "package-smoke",
      provider: "invalid",
      sessionTitle: "invalid",
    });
    return {
      imagePath: savedImage.path,
      imageReadable: typeof readImage === "string" && readImage.startsWith("data:image/png;base64,"),
      unsafeExternalRejected,
      invalidNotificationAccepted,
    };
  });
  assert(desktopIpc.imagePath.includes("package-smoke-profile"), "打包版附件没有写入隔离测试目录。");
  assert(desktopIpc.imageReadable, "打包版附件写入后无法通过受控 IPC 读取。");
  assert(desktopIpc.unsafeExternalRejected, "打包版没有拒绝非 HTTP(S) 外链。");
  assert(desktopIpc.invalidNotificationAccepted === false, "打包版接受了无效通知输入。");

  return {
    ok: true,
    results: [
      "打包版加载本地 Renderer",
      "Electron 43 和 Renderer 隔离配置正确",
      "正式 Bridge 可用且未暴露开发夹具",
      "窗口最大化切换 IPC 可用",
      "输入框鼠标和文字插入光标可见",
      "附件、外链和通知输入边界可用",
    ],
  };
}
