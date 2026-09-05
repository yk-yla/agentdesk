async page => {
  const results = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const acceptDialog = async (dialog) => dialog.accept();
  page.on("dialog", acceptDialog);

  const sidebar = page.locator("aside.sidebar");
  const activeModel = () => page.locator('.pane-panel.active-pane select[aria-label="选择模型"]');
  const activeEffort = () => page.locator('.pane-panel.active-pane select[aria-label="选择思考等级"]');
  const activeInput = () => page.locator('.pane-panel.active-pane textarea[aria-label="消息输入"]');
  const newClaude = () => sidebar.locator("button.provider-new-claude").first();
  const newCodex = () => sidebar.locator("button.provider-new-codex").first();

  try {
    await sidebar.waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForFunction(() => {
      const workspace = document.querySelector(".current-workspace");
      return Boolean(
        workspace?.getAttribute("title")
        && !workspace.textContent?.includes("正在连接工作区")
        && document.querySelector('.pane-panel textarea[aria-label="消息输入"]'),
      );
    }, null, { timeout: 15_000 });
    await page.evaluate(() => { window.confirm = () => true; });

    const hasDevBridge = await page.evaluate(() => Boolean(window.agentDesk?.dev));
    assert(hasDevBridge, "开发版 Electron 没有暴露受控测试夹具。");
    const runtime = await page.evaluate(async () => ({
      userAgent: navigator.userAgent,
      hasRendererRequire: typeof window.require !== "undefined",
      hasRendererProcess: typeof window.process !== "undefined",
      windowState: await window.agentDesk.getWindowState(),
    }));
    assert(/Electron\/43\.\d+\.\d+\b/.test(runtime.userAgent), `Electron 主版本不正确：${runtime.userAgent}`);
    assert(!runtime.hasRendererRequire && !runtime.hasRendererProcess, "Renderer 暴露了 Node 全局对象。");
    assert(runtime.windowState.maximized, "无边框主窗口启动后没有最大化。");
    const desktopUpdateFixture = await page.evaluate(() => window.agentDesk.dev.setDesktopUpdateFixture());
    assert(desktopUpdateFixture.phase === "downloaded", "桌面更新 IPC 夹具没有进入已下载状态。");
    assert((await page.evaluate(() => window.agentDesk.getUpdateStatus())).phase === "downloaded", "桌面更新状态没有通过正式 Bridge 返回。");
    results.push("真实 Electron Bridge、安全配置和桌面更新 IPC 可用");

    const currentWorkspace = sidebar.locator(".current-workspace");
    assert(await sidebar.locator(".provider-new-group").count() === 0, "侧栏顶部仍显示 Provider 大按钮。");
    assert(await currentWorkspace.locator(".provider-new-codex").count() === 1, "当前目录缺少 Codex 新建入口。");
    assert(await currentWorkspace.locator(".provider-new-claude").count() === 1, "当前目录缺少 Claude Code 外部终端入口。");
    assert(await page.locator(".terminal-pane, .terminal-host, .xterm").count() === 0, "内置终端 DOM 仍被渲染。");
    results.push("Codex 工作台和 Claude 外部终端入口可用，内置终端已移除");

    const settingsButton = sidebar.locator("button.settings-button");
    await settingsButton.click();
    const settingsPopover = sidebar.locator(".settings-popover");
    await settingsPopover.waitFor({ state: "visible", timeout: 10_000 });
    assert(await settingsPopover.getByText("Codex CLI", { exact: true }).count() === 0, "设置仍显示 Codex CLI 更新入口。");
    assert(await settingsPopover.getByText("Claude Code", { exact: true }).count() === 0, "设置仍显示 Claude Code 更新入口。");
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
      await page.waitForFunction(async expectedTheme => document.documentElement.dataset.theme === expectedTheme && (await window.agentDesk.getPreferences()).theme === expectedTheme, theme.id, { timeout: 10_000 });
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
    await page.waitForFunction(async expectedTheme => document.documentElement.dataset.theme === expectedTheme && (await window.agentDesk.getPreferences()).theme === expectedTheme, originalTheme, { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await settingsPopover.waitFor({ state: "hidden", timeout: 10_000 });
    results.push("设置弹层仅保留三套主题且切换可用");

    await sidebar.getByRole("tab", { name: "收藏", exact: true }).click({ force: true });
    await sidebar.locator('nav[aria-label="已收藏会话列表"]').waitFor({ state: "visible", timeout: 10_000 });
    assert(await currentWorkspace.count() === 0, "收藏视图仍显示当前目录卡片。");
    assert(await sidebar.locator(".history-content-search").count() === 0, "收藏视图仍显示正文搜索入口。");
    await sidebar.getByRole("tab", { name: "全部最近", exact: true }).click({ force: true });
    await sidebar.locator('nav[aria-label="全部最近会话列表"]').waitFor({ state: "visible", timeout: 10_000 });
    assert(await currentWorkspace.count() === 0, "全部最近视图仍显示当前目录卡片。");
    assert(await sidebar.getByRole("button", { name: "搜索所有目录会话正文" }).count() === 1, "全部最近视图缺少跨目录正文搜索入口。");
    await sidebar.getByRole("tab", { name: "当前目录" }).click({ force: true });
    await sidebar.locator('nav[aria-label="当前目录会话列表"]').waitFor({ state: "visible", timeout: 10_000 });
    await currentWorkspace.waitFor({ state: "visible", timeout: 10_000 });
    assert(await sidebar.getByRole("button", { name: "搜索当前目录会话正文" }).count() === 1, "当前目录视图缺少目录内正文搜索入口。");
    results.push("当前目录、收藏和全部最近视图可切换，搜索范围正确");

    await newCodex().click({ force: true });
    await page.waitForFunction(() => {
      const model = Array.from(document.querySelectorAll('.pane-panel select[aria-label="选择模型"]'))
        .find(element => element.getClientRects().length > 0);
      const effort = Array.from(document.querySelectorAll('.pane-panel select[aria-label="选择思考等级"]'))
        .find(element => element.getClientRects().length > 0);
      return model instanceof HTMLSelectElement && !model.disabled && model.options.length > 0
        && effort instanceof HTMLSelectElement && !effort.disabled && effort.options.length > 1;
    }, null, { timeout: 60_000 });
    assert(await newClaude().count() === 1, "Claude Code 外部终端入口不可用。");
    const model = activeModel();
    const codexModels = await model.locator("option").evaluateAll(options => options.map(option => option.value));
    assert(codexModels.length > 0, "Codex 启动模型列表为空。");
    assert(!codexModels.some(id => ["default", "sonnet", "haiku", "opus"].includes(id)), `Codex 模型列表混入了 Claude 模型：${codexModels.join(", ")}`);
    const currentCodexModel = await model.inputValue();
    const secondCodexModel = codexModels.find(id => id !== currentCodexModel);
    if (secondCodexModel) {
      await model.selectOption(secondCodexModel);
      await page.waitForFunction(expected => {
        const selected = document.querySelector('.pane-panel.active-pane select[aria-label="选择模型"]');
        return selected instanceof HTMLSelectElement && selected.value === expected;
      }, secondCodexModel, { timeout: 10_000 });
      await page.waitForFunction(async expected => (await window.agentDesk.getPreferences()).lastModels?.codex === expected, secondCodexModel, { timeout: 10_000 });
    }
    const effort = activeEffort();
    const codexEffortOptions = await effort.locator("option").evaluateAll(options => options.map(option => option.value));
    assert(codexEffortOptions.length > 1, `Codex 思考等级选项不足：${codexEffortOptions.join(", ")}`);
    const currentCodexEffort = await effort.inputValue();
    const targetCodexEffort = codexEffortOptions.find(value => value !== currentCodexEffort) || currentCodexEffort;
    await effort.selectOption(targetCodexEffort);
    await page.waitForFunction(async expected => (await window.agentDesk.getPreferences()).lastReasoningEfforts?.codex === expected, targetCodexEffort, { timeout: 10_000 });
    await newCodex().click({ force: true });
    await page.waitForFunction(() => {
      const model = document.querySelector('.pane-panel.active-pane select[aria-label="选择模型"]');
      const effort = document.querySelector('.pane-panel.active-pane select[aria-label="选择思考等级"]');
      return model instanceof HTMLSelectElement && !model.disabled && effort instanceof HTMLSelectElement && !effort.disabled;
    }, null, { timeout: 60_000 });
    if (secondCodexModel) assert(await activeModel().inputValue() === secondCodexModel, "Codex 新会话没有沿用上次模型。");
    assert(await activeEffort().inputValue() === targetCodexEffort, "Codex 新会话没有沿用上次思考等级。");
    const composerPointerStyle = await activeInput().evaluate(element => {
      const style = getComputedStyle(element);
      return { cursor: style.cursor, caretColor: style.caretColor };
    });
    assert(composerPointerStyle.cursor === "default", `输入框鼠标仍可能不可见：${composerPointerStyle.cursor}`);
    assert(composerPointerStyle.caretColor !== "rgba(0, 0, 0, 0)", "输入框文字插入光标是透明的。");
    assert(!(await activeInput().isDisabled()), "Codex 消息输入框不可用。");
    results.push("Codex 模型、思考等级、输入框和偏好记忆可用");

    const historyEntry = sidebar.locator(".thread-item").first();
    await historyEntry.waitFor({ state: "visible", timeout: 15_000 });
    await historyEntry.click({ button: "right", force: true });
    const historyMenu = page.getByRole("menu", { name: /会话操作/ });
    await historyMenu.waitFor({ state: "visible", timeout: 10_000 });
    assert(await historyMenu.getByRole("menuitem", { name: /在工作台打开/ }).count() === 1, "历史会话菜单缺少工作台打开操作。");
    assert(await historyMenu.getByRole("menuitem", { name: /在外部终端打开/ }).count() <= 1, "历史会话菜单存在重复的外部终端操作。");
    assert(await historyMenu.getByRole("menuitem", { name: /收藏/ }).count() === 1, "历史会话菜单缺少收藏操作。");
    await page.keyboard.press("Escape");
    await historyMenu.waitFor({ state: "hidden", timeout: 10_000 });
    results.push("历史会话工作台打开菜单可用");

    return { ok: true, results };
  } finally {
    page.off("dialog", acceptDialog);
  }
}
