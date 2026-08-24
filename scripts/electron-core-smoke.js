async page => {
  const results = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const acceptDialog = async (dialog) => dialog.accept();
  page.on("dialog", acceptDialog);

  const sidebar = page.locator("aside.sidebar");
  const activeModel = () => page.locator('.pane-panel select[aria-label="选择模型"]');
  const activeEffort = () => page.locator('.pane-panel select[aria-label="选择思考等级"]');
  const activeInput = () => page.locator('.pane-panel textarea[aria-label="消息输入"]');
  const activeTerminal = () => page.locator(".pane-panel .terminal-pane");
  const newClaude = () => sidebar.locator("button.provider-new-claude").first();
  const newCodex = () => sidebar.locator("button.provider-new-codex").first();
  // Claude Code 只有黑窗口（内置终端）形态，Codex 才有图形界面，所以两者的
  // “会话已就绪”判断不同：Claude 等 xterm 渲染，Codex 等消息输入框可用。
  // 分栏时每个栏各有一个 .tab.active，所以按 Provider 标记挑，不能只取第一个。
  const openSession = async (provider, button, presentation) => {
    const previousIds = await page.evaluate((expectedProvider) => (
      Array.from(document.querySelectorAll(`.tab.active:has(.provider-mark.${expectedProvider})`))
        .map((tab) => tab.getAttribute("data-session-id"))
    ), provider);
    await button().click({ force: true });
    await page.waitForFunction(({ expectedProvider, expectedPresentation, previousList }) => {
      const activeTab = Array.from(document.querySelectorAll(".tab.active"))
        .find((tab) => tab.querySelector(`.provider-mark.${expectedProvider}`)
          && tab.getAttribute("data-session-id")
          && !previousList.includes(tab.getAttribute("data-session-id")));
      if (!activeTab) return false;
      if (expectedPresentation === "terminal") {
        return Boolean(document.querySelector(".pane-panel .terminal-pane .terminal-host-inner .xterm-rows"));
      }
      const composer = document.querySelector('.pane-panel textarea[aria-label="消息输入"]');
      return composer instanceof HTMLTextAreaElement && !composer.disabled;
    }, { expectedProvider: provider, expectedPresentation: presentation, previousList: previousIds }, { timeout: 30_000 });
    return page.evaluate((expectedProvider) => (
      Array.from(document.querySelectorAll(".tab.active"))
        .find((tab) => tab.querySelector(`.provider-mark.${expectedProvider}`))
        ?.getAttribute("data-session-id") || null
    ), provider);
  };
  const openClaudeTerminal = async () => openSession("claude", newClaude, "terminal");
  // Codex 的模型和思考等级要等 app-server 初始化完才可用，启动耗时随机器和
  // 上一轮进程退出情况波动，所以显式等它就绪，不能开完会话就断言。
  const openCodexWorkbench = async () => {
    const sessionId = await openSession("codex", newCodex, "workbench");
    await page.waitForFunction(() => {
      const model = document.querySelector('.pane-panel select[aria-label="选择模型"]');
      const effort = document.querySelector('.pane-panel select[aria-label="选择思考等级"]');
      return model instanceof HTMLSelectElement && !model.disabled && model.options.length > 0
        && effort instanceof HTMLSelectElement && !effort.disabled && effort.options.length > 1;
    }, null, { timeout: 60_000 });
    return sessionId;
  };

  try {
    await sidebar.waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForFunction(() => {
      const workspace = document.querySelector(".current-workspace");
      return Boolean(
        workspace?.getAttribute("title")
        && !workspace.textContent?.includes("正在连接工作区")
        && document.querySelector(".pane-panel textarea[aria-label='消息输入']"),
      );
    }, null, { timeout: 15_000 });
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
    assert(await sidebar.locator(".provider-new-group").count() === 0, "侧栏顶部仍显示 Codex、Claude 大按钮。" );
    assert(await currentWorkspace.locator(".provider-new-codex").count() === 1, "当前目录缺少 Codex 新建入口。" );
    assert(await currentWorkspace.locator(".provider-new-claude").count() === 1, "当前目录缺少 Claude Code 新建入口。" );
    const currentWorkspacePin = currentWorkspace.locator(".current-workspace-pin");
    if (await currentWorkspacePin.getAttribute("aria-pressed") !== "true") await currentWorkspacePin.click();
    assert(await currentWorkspace.locator(".current-workspace-terminal").count() === 0, "当前目录仍显示已移除的 WT 入口。" );
    assert(await sidebar.locator(".shortcut-row .shortcut-terminal").count() === 0, "固定目录仍显示已移除的 WT 入口。" );
    results.push("Codex、Claude 和内置终端入口可用，外部 WT 入口已移除");

    const settingsButton = sidebar.locator("button.settings-button");
    await settingsButton.click();
    const settingsPopover = sidebar.locator(".settings-popover");
    await settingsPopover.waitFor({ state: "visible", timeout: 10_000 });
    const themeSelect = settingsPopover.locator("label", { hasText: "主题" }).locator("select");
    const originalTheme = await page.evaluate(async () => (await window.agentDesk.getPreferences()).theme);
    const themes = [
      { id: "github-light", background: "#f6f8fa", accent: "#20a675" },
      { id: "modern-dark", background: "#1f1f1f", accent: "#3794ff" },
      { id: "github-dark-dimmed", background: "#22272e", accent: "#539bf5" },
    ];
    const themeOptions = await themeSelect.locator("option").evaluateAll((options) => options.map((option) => option.value));
    assert(JSON.stringify(themeOptions) === JSON.stringify(themes.map((theme) => theme.id)), `主题下拉没有只保留三项：${themeOptions.join(", ")}`);
    for (const theme of themes) {
      await themeSelect.selectOption(theme.id);
      await page.waitForFunction(async (expectedTheme) => (
        document.documentElement.dataset.theme === expectedTheme
        && (await window.agentDesk.getPreferences()).theme === expectedTheme
      ), theme.id, { timeout: 10_000 });
      const colors = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return {
          background: style.getPropertyValue("--background").trim(),
          accent: style.getPropertyValue("--accent").trim(),
        };
      });
      assert(colors.background === theme.background, `${theme.id} 背景色未生效：${colors.background}`);
      assert(colors.accent === theme.accent, `${theme.id} 强调色未生效：${colors.accent}`);
    }
    await themeSelect.selectOption(originalTheme);
    await page.waitForFunction(async (expectedTheme) => (
      document.documentElement.dataset.theme === expectedTheme
      && (await window.agentDesk.getPreferences()).theme === expectedTheme
    ), originalTheme, { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await settingsPopover.waitFor({ state: "hidden", timeout: 10_000 });
    results.push("设置弹层仅保留三套主题且切换可用");

    await sidebar.getByRole("tab", { name: "收藏", exact: true }).click({ force: true });
    await sidebar.locator('nav[aria-label="已收藏会话列表"]').waitFor({ state: "visible", timeout: 10_000 });
    assert(await currentWorkspace.count() === 0, "收藏视图仍显示当前目录卡片。" );
    assert(await sidebar.locator(".history-content-search").count() === 0, "收藏视图仍显示正文搜索入口。" );
    await sidebar.getByRole("tab", { name: "全部最近", exact: true }).click({ force: true });
    await sidebar.locator('nav[aria-label="全部最近会话列表"]').waitFor({ state: "visible", timeout: 10_000 });
    assert(await currentWorkspace.count() === 0, "全部最近视图仍显示当前目录卡片。" );
    assert(await sidebar.getByRole("button", { name: "搜索所有目录会话正文" }).count() === 1, "全部最近视图缺少跨目录正文搜索入口。" );
    await sidebar.getByRole("tab", { name: "当前目录" }).click({ force: true });
    await sidebar.locator('nav[aria-label="当前目录会话列表"]').waitFor({ state: "visible", timeout: 10_000 });
    await currentWorkspace.waitFor({ state: "visible", timeout: 10_000 });
    assert(await sidebar.getByRole("button", { name: "搜索当前目录会话正文" }).count() === 1, "当前目录视图缺少目录内正文搜索入口。" );
    results.push("当前目录、收藏和全部最近视图可切换，搜索范围正确");

    // Claude Code 现在只跑黑窗口：新会话必须直接落在内置终端，并且不能显示
    // 能力注册表里标记为 unsupported 的模型、思考等级和图形界面输入框。
    await openClaudeTerminal();
    assert(await activeTerminal().count() === 1, "Claude 新会话没有以黑窗口打开。" );
    await page.waitForFunction(() => !document.querySelector(".pane-panel .terminal-status"), null, { timeout: 20_000 });
    assert(await page.locator(".pane-panel .terminal-host-inner .xterm-rows").count() === 1, "Claude 黑窗口没有渲染终端内容。" );
    assert(await activeModel().count() === 0, "Claude 黑窗口仍显示模型选择入口，与 models 能力不符。" );
    assert(await activeEffort().count() === 0, "Claude 黑窗口仍显示思考等级入口，与 effort 能力不符。" );
    assert(await activeInput().count() === 0, "Claude 黑窗口仍显示图形界面消息输入框。" );
    assert(await page.locator(".pane-panel .terminal-error").count() === 0, "Claude 黑窗口启动后留下错误提示。" );
    results.push("Claude 新会话直达黑窗口，终端就绪且不暴露未支持的图形界面能力");

    // 图形界面能力只剩 Codex，模型、思考等级和输入框的验证都走 Codex。
    await openCodexWorkbench();
    const model = activeModel();
    await model.waitFor({ state: "visible", timeout: 15_000 });
    assert(!(await model.isDisabled()), "Codex 新会话模型下拉框仍被禁用。" );
    const codexModels = await model.locator("option").evaluateAll((options) => options.map((option) => option.value));
    assert(codexModels.length > 0, "Codex 启动模型列表为空。" );
    assert(!codexModels.some((id) => ["default", "sonnet", "haiku", "opus"].includes(id)), `Codex 模型列表混入了 Claude 模型：${codexModels.join(", ")}`);
    const currentCodexModel = await model.inputValue();
    const secondCodexModel = codexModels.find((id) => id !== currentCodexModel);
    if (secondCodexModel) {
      await model.selectOption(secondCodexModel);
      assert(await model.inputValue() === secondCodexModel, "Codex 模型选择没有更新。" );
    }
    results.push("Codex 首条消息前模型可选择且不混入 Claude 模型");

    const codexEffortOptions = await activeEffort().locator("option").evaluateAll((options) => options.map((option) => option.value));
    assert(codexEffortOptions.length > 1, `Codex 思考等级选项不足：${codexEffortOptions.join(", ")}`);
    const currentCodexEffort = await activeEffort().inputValue();
    const targetCodexEffort = codexEffortOptions.find((value) => value !== currentCodexEffort) || currentCodexEffort;
    await activeEffort().selectOption(targetCodexEffort);
    await page.waitForFunction(async (expected) => (await window.agentDesk.getPreferences()).lastReasoningEfforts?.codex === expected, targetCodexEffort, { timeout: 10_000 });
    await openCodexWorkbench();
    assert(await activeEffort().inputValue() === targetCodexEffort, "Codex 新会话没有沿用上次思考等级。" );
    results.push("Codex 记住上次思考等级");

    const composerPointerStyle = await activeInput().evaluate((element) => {
      const style = getComputedStyle(element);
      return { cursor: style.cursor, caretColor: style.caretColor };
    });
    assert(composerPointerStyle.cursor === "default", `输入框鼠标仍可能不可见：${composerPointerStyle.cursor}`);
    assert(composerPointerStyle.caretColor !== "rgba(0, 0, 0, 0)", "输入框文字插入光标是透明的。" );
    results.push("输入框鼠标和文字插入光标可见");

    const historyEntry = sidebar.locator(".thread-item").first();
    await historyEntry.waitFor({ state: "visible", timeout: 15_000 });
    await historyEntry.click({ button: "right", force: true });
    const historyMenu = page.getByRole("menu", { name: /会话操作/ });
    await historyMenu.waitFor({ state: "visible", timeout: 10_000 });
    assert(await historyMenu.getByRole("menuitem", { name: /收藏/ }).count() === 1, "历史会话菜单缺少收藏操作。" );
    await page.keyboard.press("Escape");
    await historyMenu.waitFor({ state: "hidden", timeout: 10_000 });
    results.push("历史会话右键菜单可用");

    // Provider 隔离：关掉 Claude 黑窗口标签，不能切走、禁用或污染当前 Codex 会话。
    const claudeSessionId = await openClaudeTerminal();
    const codexSessionId = await openCodexWorkbench();
    assert(claudeSessionId && codexSessionId && claudeSessionId !== codexSessionId, "隔离验证没有拿到两个独立会话。" );
    await page.locator(`.tab[data-session-id="${claudeSessionId}"] .tab-close`).click({ force: true });
    await page.waitForFunction((sessionId) => !document.querySelector(`.tab[data-session-id="${sessionId}"]`), claudeSessionId, { timeout: 20_000 });
    const codexStillActive = await page.evaluate((sessionId) => Boolean(
      document.querySelector(`.tab.active[data-session-id="${sessionId}"]`),
    ), codexSessionId);
    assert(codexStillActive, "关闭 Claude 黑窗口标签后 Codex 会话不再是活动标签。" );
    assert(await page.locator(".pane-panel .error-banner").count() === 0, "关闭 Claude 黑窗口污染了 Codex 活动会话。" );
    assert(!(await activeInput().isDisabled()), "关闭 Claude 黑窗口后 Codex 输入框不可用。" );
    results.push("关闭 Claude 黑窗口标签即时生效且不影响 Codex 会话");

    return { ok: true, results };
  } finally {
    page.off("dialog", acceptDialog);
  }
}
