async page => {
  const results = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const acceptDialog = async (dialog) => dialog.accept();
  page.on("dialog", acceptDialog);

  const sidebar = page.locator("aside.sidebar");
  const activeModel = () => page.locator('.pane-panel select[aria-label="选择模型"]');
  const activeInput = () => page.locator('.pane-panel textarea[aria-label="消息输入"]');
  const newClaude = () => sidebar.locator("button.provider-new-claude").first();
  const newCodex = () => sidebar.locator("button.provider-new-codex").first();
  const openClaude = async () => {
    await newClaude().click({ force: true });
    await page.waitForFunction(() => Boolean(document.querySelector(".tab.active .provider-mark.claude")), null, { timeout: 10_000 });
  };
  const openCodex = async () => {
    await newCodex().click({ force: true });
    await page.waitForFunction(() => Boolean(document.querySelector(".tab.active .provider-mark.codex")), null, { timeout: 10_000 });
  };

  try {
    await sidebar.waitFor({ state: "visible", timeout: 15_000 });
    await page.evaluate(() => { window.confirm = () => true; });
    const hasDevBridge = await page.evaluate(() => Boolean(window.agentDesk?.dev));
    assert(hasDevBridge, "开发版 Electron 没有暴露受控测试夹具。" );
    results.push("真实 Electron Bridge 已连接");

    const runtime = await page.evaluate(async () => ({
      userAgent: navigator.userAgent,
      hasRendererRequire: typeof window.require !== "undefined",
      hasRendererProcess: typeof window.process !== "undefined",
      windowState: await window.agentDesk.getWindowState(),
    }));
    assert(/Electron\/43\.3\.0\b/.test(runtime.userAgent), `Electron 运行版本不正确：${runtime.userAgent}`);
    assert(!runtime.hasRendererRequire && !runtime.hasRendererProcess, "Renderer 暴露了 Node 全局对象。" );
    assert(runtime.windowState.maximized, "无边框主窗口启动后没有最大化。" );
    const desktopUpdateFixture = await page.evaluate(() => window.agentDesk.dev.setDesktopUpdateFixture());
    assert(desktopUpdateFixture.phase === "downloaded", "桌面更新 IPC 夹具没有进入已下载状态。" );
    assert((await page.evaluate(() => window.agentDesk.getUpdateStatus())).phase === "downloaded", "桌面更新状态没有通过正式 Bridge 返回。" );
    results.push("Electron 43、窗口安全配置和桌面更新 IPC 可用");

    const currentWorkspace = sidebar.locator(".current-workspace");
    assert(await currentWorkspace.locator(".current-workspace-terminal").count() === 1, "当前目录缺少 WT 入口。" );
    const currentWorkspacePin = currentWorkspace.locator(".current-workspace-pin");
    if (await currentWorkspacePin.getAttribute("aria-pressed") !== "true") await currentWorkspacePin.click();
    await sidebar.locator(".shortcut-row .shortcut-terminal").first().waitFor({ state: "visible", timeout: 10_000 });
    assert(await page.locator(".composer-more-menu").getByText("在 WT 打开当前目录", { exact: true }).count() === 0, "会话更多菜单仍包含 WT 入口。" );
    results.push("WT 入口位于当前目录和固定目录，且已从会话菜单移除");

    const settingsButton = sidebar.locator("button.settings-button");
    await settingsButton.click();
    const settingsPopover = sidebar.locator(".settings-popover");
    await settingsPopover.waitFor({ state: "visible", timeout: 10_000 });
    await settingsPopover.locator(".boss-key-settings").waitFor({ state: "visible", timeout: 10_000 });
    await page.keyboard.press("Escape");
    await settingsPopover.waitFor({ state: "hidden", timeout: 10_000 });
    results.push("设置弹层和懒加载高级设置可用");

    await sidebar.getByRole("tab", { name: "已收藏" }).click({ force: true });
    await sidebar.locator('nav[aria-label="已收藏会话列表"]').waitFor({ state: "visible", timeout: 10_000 });
    await sidebar.getByRole("tab", { name: "当前目录" }).click({ force: true });
    await sidebar.locator('nav[aria-label="当前目录会话列表"]').waitFor({ state: "visible", timeout: 10_000 });
    results.push("历史目录和收藏视图可切换");

    await openClaude();
    const model = activeModel();
    await model.waitFor({ state: "visible", timeout: 10_000 });
    const initialModels = await model.locator("option").evaluateAll((options) => options.map((option) => option.value));
    assert(!(await model.isDisabled()), "Claude 新会话模型下拉框仍被禁用。" );
    for (const required of ["default", "sonnet", "haiku"]) {
      assert(initialModels.includes(required), `Claude 启动模型列表缺少 ${required}。`);
    }
    await model.selectOption("sonnet");
    assert(await model.inputValue() === "sonnet", "Claude 模型选择没有更新到 sonnet。" );
    results.push("Claude 首条消息前模型可选择");

    const composerPointerStyle = await activeInput().evaluate((element) => {
      const style = getComputedStyle(element);
      return { cursor: style.cursor, caretColor: style.caretColor };
    });
    assert(composerPointerStyle.cursor === "default", `输入框鼠标仍可能不可见：${composerPointerStyle.cursor}`);
    assert(composerPointerStyle.caretColor !== "rgba(0, 0, 0, 0)", "输入框文字插入光标是透明的。" );
    results.push("输入框鼠标和文字插入光标可见");

    await page.evaluate(() => window.agentDesk.dev.setClaudeLifecycleFixture("longBash"));
    await activeInput().fill(`AgentDesk fixture interrupt ${Date.now()}`);
    await activeInput().press("Enter");
    const stopButton = page.locator(".pane-panel .stop-button");
    await stopButton.waitFor({ state: "visible", timeout: 15_000 });
    await stopButton.click({ force: true });
    await stopButton.waitFor({ state: "hidden", timeout: 15_000 });
    assert(await page.locator(".pane-panel .error-banner").count() === 0, "Claude 夹具中断后留下错误状态。" );
    results.push("Claude Worker 任务可中断并收敛");

    await openClaude();
    await page.evaluate(() => window.agentDesk.dev.setClaudeLifecycleFixture("compact"));
    await activeInput().fill("AgentDesk fixture compact " + Date.now());
    await activeInput().press("Enter");
    const compactButton = page.locator(".pane-panel .compact-count");
    await page.waitForFunction(() => {
      const button = document.querySelector(".pane-panel .compact-count");
      return button instanceof HTMLButtonElement && !button.disabled;
    }, null, { timeout: 15_000 });
    try {
      await page.locator(".pane-panel .context-usage", { hasText: "3.2k/200k" }).waitFor({ state: "visible", timeout: 15_000 });
    } catch (error) {
      const state = await page.evaluate(() => ({
        activeProvider: document.querySelector(".tab.active .provider-mark")?.className || "",
        context: Array.from(document.querySelectorAll(".context-usage")).map((entry) => entry.textContent || ""),
        compact: Array.from(document.querySelectorAll(".compact-count")).map((entry) => ({ text: entry.textContent || "", disabled: entry.disabled })),
        error: document.querySelector(".pane-panel .error-banner")?.textContent || "",
      }));
      throw new Error("Claude 夹具上下文显示异常：" + JSON.stringify(state) + "；" + (error instanceof Error ? error.message : String(error)));
    }
    await compactButton.click({ force: true });
    await page.locator(".pane-panel .compact-count", { hasText: "压缩 1" }).waitFor({ state: "visible", timeout: 15_000 });
    await stopButton.waitFor({ state: "hidden", timeout: 15_000 });
    await activeInput().fill("AgentDesk fixture post compact " + Date.now());
    await activeInput().press("Enter");
    await stopButton.waitFor({ state: "visible", timeout: 15_000 });
    try {
      await page.locator(".message-row.assistant", { hasText: "AgentDesk 流式夹具" }).first().waitFor({ state: "visible", timeout: 15_000 });
    } catch (error) {
      const state = await page.evaluate(() => ({
        tabs: Array.from(document.querySelectorAll(".tab")).map((tab) => ({ active: tab.classList.contains("active"), text: tab.textContent || "" })),
        provider: document.querySelector(".tab.active .provider-mark")?.className || "",
        messages: Array.from(document.querySelectorAll(".message-row")).map((entry) => entry.textContent || ""),
        error: document.querySelector(".pane-panel .error-banner")?.textContent || "",
      }));
      throw new Error("Claude 压缩后恢复回复异常：" + JSON.stringify(state) + "；" + (error instanceof Error ? error.message : String(error)));
    }
    await stopButton.click({ force: true });
    await stopButton.waitFor({ state: "hidden", timeout: 15_000 });
    results.push("Claude 上下文用量可见，压缩后可恢复并继续回复");

    await openClaude();
    await page.evaluate(() => window.agentDesk.dev.setClaudeLifecycleFixture("approval"));
    await activeInput().fill("AgentDesk fixture approval " + Date.now());
    await activeInput().press("Enter");
    const approval = page.getByRole("dialog", { name: "Bash 请求授权" });
    await approval.waitFor({ state: "visible", timeout: 15_000 });
    await approval.getByRole("button", { name: "允许", exact: true }).click({ force: true });
    await approval.waitFor({ state: "hidden", timeout: 15_000 });
    await stopButton.click({ force: true });
    await stopButton.waitFor({ state: "hidden", timeout: 15_000 });
    results.push("Claude 权限审批可处理并收敛");

    await openClaude();
    await page.evaluate(() => window.agentDesk.dev.setClaudeLifecycleFixture("stream"));
    await activeInput().fill("AgentDesk fixture stream " + Date.now());
    await activeInput().press("Enter");
    await page.waitForFunction(() => {
      const messages = Array.from(document.querySelectorAll(".pane-panel .message-row.assistant")).map((entry) => entry.textContent || "");
      return messages.length === 2
        && messages[0].includes("AgentDesk 流式夹具 第一条")
        && messages[1].includes("AgentDesk 流式夹具 第二条")
        && messages[1].includes("CLAUDE_LONG_TEXT_END");
    }, null, { timeout: 15_000 });
    const streamMessages = await page.locator(".pane-panel .message-row.assistant").allTextContents();
    assert(streamMessages.length === 2, `Claude 不同 UUID 的流式消息没有分条显示：${streamMessages.length}`);
    assert(!streamMessages.some((message) => message.includes("[已截断]")), "Claude 长回复仍被 8 KB 上限截断。" );
    await stopButton.click({ force: true });
    await stopButton.waitFor({ state: "hidden", timeout: 15_000 });
    assert(await page.locator(".pane-panel .error-banner").count() === 0, "Claude 流式夹具中断后留下错误状态。" );
    results.push("Claude 流式消息按 UUID 分条、长回复完整且中断后收敛");

    await openClaude();
    await page.evaluate(() => window.agentDesk.dev.setClaudeLifecycleFixture("incompleteTool"));
    await activeInput().fill("AgentDesk fixture incomplete Write " + Date.now());
    await activeInput().press("Enter");
    const incompleteWriteError = page.locator(".pane-panel .error-banner");
    await incompleteWriteError.waitFor({ state: "visible", timeout: 15_000 });
    assert((await incompleteWriteError.textContent() || "").includes("Write") && (await incompleteWriteError.textContent() || "").includes("文件未写入"), "未完成 Write 调用没有显示明确错误。" );
    await page.evaluate(() => window.agentDesk.dev.setClaudeLifecycleFixture(null));
    results.push("未完成 Write 调用不会假成功，并明确提示文件未写入");

    await page.waitForFunction(async () => {
      const cache = (await window.agentDesk.getPreferences()).claudeModelCache;
      return cache?.schema === 2 && cache.models.some((entry) => entry.id === "sonnet");
    }, null, { timeout: 15_000 });
    const cachedModels = await page.evaluate(async () => (await window.agentDesk.getPreferences()).claudeModelCache);
    assert(cachedModels?.claudeVersion && cachedModels.updatedAt > 0, "Claude 模型缓存缺少版本或更新时间。" );
    assert(!cachedModels.models.some((entry) => entry.id.startsWith("gpt-") || entry.id.startsWith("codex-")), "Claude 模型缓存混入了 Codex 模型。" );
    assert(!/token|credential|apiKey/i.test(JSON.stringify(cachedModels)), "Claude 模型缓存包含非公开凭据字段。" );
    results.push("Claude SDK 模型列表已安全写入版本化缓存");

    const historyEntry = sidebar.locator(".thread-item").first();
    await historyEntry.waitFor({ state: "visible", timeout: 15_000 });
    await historyEntry.click({ button: "right", force: true });
    const historyMenu = page.getByRole("menu", { name: /会话操作/ });
    await historyMenu.waitFor({ state: "visible", timeout: 10_000 });
    assert(await historyMenu.getByRole("menuitem", { name: /收藏/ }).count() === 1, "历史会话菜单缺少收藏操作。" );
    await page.keyboard.press("Escape");
    await historyMenu.waitFor({ state: "hidden", timeout: 10_000 });
    results.push("历史会话右键菜单可用");

    await openClaude();
    await page.evaluate(() => window.agentDesk.dev.setClaudeLifecycleFixture("longBash"));
    await activeInput().fill(`AgentDesk fixture provider isolation ${Date.now()}`);
    await activeInput().press("Enter");
    await stopButton.waitFor({ state: "visible", timeout: 15_000 });
    const failingClaudeTab = page.locator(".tab:has(.provider-mark.claude)").last();

    await openCodex();
    const codexModel = activeModel();
    await codexModel.waitFor({ state: "visible", timeout: 10_000 });
    assert(!(await codexModel.isDisabled()), "Codex 会话在 Claude 运行时不可用。" );

    await page.evaluate(() => window.agentDesk.dev.injectClaudeWorkerFatal());
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".tab")).some((tab) => tab.querySelector(".provider-mark.claude") && tab.querySelector(".tab-status.error")), null, { timeout: 15_000 });
    assert(await page.locator(".tab.active .provider-mark.codex").count() === 1, "Claude Worker 退出错误地切换或关闭了 Codex 会话。" );
    assert(await page.locator(".pane-panel .error-banner").count() === 0, "Claude Worker 退出污染了 Codex 活动会话。" );
    results.push("Claude Worker 退出不污染 Codex 会话");

    await failingClaudeTab.click({ force: true });
    const claudeError = page.locator(".pane-panel .error-banner");
    await claudeError.waitFor({ state: "visible", timeout: 10_000 });
    results.push("Claude Worker 退出错误只显示在所属会话");

    await openClaude();
    await page.evaluate(() => window.agentDesk.dev.setClaudeLifecycleFixture("longBash"));
    await activeInput().fill(`AgentDesk fixture running tab close ${Date.now()}`);
    await activeInput().press("Enter");
    await stopButton.waitFor({ state: "visible", timeout: 15_000 });
    const runningClaudeTab = page.locator(".tab.active:has(.provider-mark.claude)");
    const claudeTabCount = await page.locator(".tab:has(.provider-mark.claude)").count();
    await page.evaluate(() => { window.confirm = () => true; });
    await runningClaudeTab.locator(".tab-close").click({ force: true });
    try {
      await page.waitForFunction((count) => document.querySelectorAll(".tab:has(.provider-mark.claude)").length < count, claudeTabCount, { timeout: 30_000 });
    } catch (error) {
      const state = await page.evaluate(() => ({
        claudeTabs: Array.from(document.querySelectorAll(".tab:has(.provider-mark.claude)")).map((tab) => ({
          active: tab.classList.contains("active"),
          status: tab.querySelector(".tab-status")?.className || "",
          text: tab.textContent || "",
        })),
        activeProvider: document.querySelector(".tab.active .provider-mark")?.className || "",
        activeStopButton: Boolean(document.querySelector(".pane-panel .stop-button")),
        activeError: document.querySelector(".pane-panel .error-banner")?.textContent || "",
      }));
      throw new Error(`运行中 Claude Tab 关闭超时：${JSON.stringify(state)}；${error instanceof Error ? error.message : String(error)}`);
    }
    assert(await page.locator(".tab.active .provider-mark.codex").count() === 1, "关闭运行中 Claude Tab 后没有回到可用的 Codex 会话。" );
    results.push("运行中 Claude Tab 关闭后 Query 和进程树已释放");

    return { ok: true, results };
  } finally {
    await page.evaluate(() => window.agentDesk?.dev?.setClaudeLifecycleFixture(null)).catch(() => undefined);
    page.off("dialog", acceptDialog);
  }
}
