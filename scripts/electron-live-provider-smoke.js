async page => {
  const results = [];
  let stage = "初始化";
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const acceptDialog = async (dialog) => dialog.accept();
  page.on("dialog", acceptDialog);

  const state = async () => page.evaluate(() => ({
    tabs: Array.from(document.querySelectorAll(".tab")).map((tab) => ({
      active: tab.classList.contains("active"),
      provider: tab.querySelector(".provider-mark")?.className || "",
      title: tab.querySelector(".tab-title")?.textContent || "",
    })),
    activeStatus: document.querySelector(".pane-panel .status-label")?.textContent || "",
    model: document.querySelector('.pane-panel select[aria-label="选择模型"]')?.value || "",
    effort: document.querySelector('.pane-panel select[aria-label="选择思考等级"]')?.value || "",
    inputDisabled: document.querySelector('.pane-panel textarea[aria-label="消息输入"]')?.hasAttribute("disabled") || false,
    attachmentCount: document.querySelectorAll(".pane-panel .attachment-preview").length,
    error: document.querySelector(".pane-panel .error-banner")?.textContent || "",
    messages: Array.from(document.querySelectorAll(".pane-panel .message-row")).slice(-6).map((row) => row.textContent || ""),
  }));
  const failWithState = async (message, error) => {
    throw new Error(`${message}：${JSON.stringify(await state())}；${error instanceof Error ? error.message : String(error)}`);
  };

  const sidebar = page.locator("aside.sidebar");
  const pluginButton = sidebar.locator('button[aria-label="插件市场"]');
  const activeModel = () => page.locator('.pane-panel select[aria-label="选择模型"]');
  const activeEffort = () => page.locator('.pane-panel select[aria-label="选择思考等级"]');
  const activeInput = () => page.locator('.pane-panel textarea[aria-label="消息输入"]');
  const modelResponse = page.locator('.message-row.assistant', { hasText: "Current model: Sonnet" });
  const openClaude = async () => {
    await sidebar.locator("button.provider-new-claude").first().click({ force: true });
    await page.waitForFunction(() => Boolean(document.querySelector(".tab.active .provider-mark.claude")), null, { timeout: 10_000 });
  };

  try {
    stage = "双 Provider 插件标签";
    await page.evaluate(() => window.agentDesk.dev.setClaudeLifecycleFixture(null));
    await pluginButton.waitFor({ state: "visible", timeout: 15_000 });
    await pluginButton.click({ force: true });
    const pluginDialog = page.locator('.plugin-overlay[aria-label="插件市场"]');
    await pluginDialog.waitFor({ state: "visible", timeout: 30_000 });
    await pluginDialog.locator(".plugin-provider-tabs").waitFor({ state: "visible", timeout: 30_000 });
    const pluginTabs = pluginDialog.locator('.plugin-provider-tabs button[role="tab"]');
    assert(await pluginTabs.count() === 2, "插件市场缺少 Codex 与 Claude Code 两个 Provider 标签。");
    await pluginDialog.getByRole("tab", { name: "Claude Code" }).click({ force: true });
    await pluginDialog.locator(".plugin-empty").waitFor({ state: "visible", timeout: 30_000 });
    await pluginDialog.getByRole("tab", { name: "Codex" }).click({ force: true });
    await pluginDialog.locator(".plugin-empty").waitFor({ state: "visible", timeout: 30_000 });
    await pluginDialog.getByRole("button", { name: "关闭插件市场" }).click({ force: true });
    results.push("插件市场可在 Codex 与 Claude Code 标签间切换且状态不串台");

    stage = "Codex 首条消息";
    await sidebar.locator("button.provider-new-codex").first().click({ force: true });
    await page.waitForFunction(() => Boolean(document.querySelector(".tab.active .provider-mark.codex")), null, { timeout: 10_000 });
    const codexMarker = `AGENTDESK_CODEX_${Date.now()}`;
    await activeInput().fill(`Reply with exactly this text and nothing else: ${codexMarker}`);
    await activeInput().press("Enter");
    await page.locator('.message-row.assistant', { hasText: codexMarker }).first().waitFor({ state: "visible", timeout: 120_000 });
    await page.locator(".pane-panel .stop-button").waitFor({ state: "hidden", timeout: 120_000 });
    assert(await page.locator(".tab.active .provider-mark.codex").count() === 1, "Codex 首条消息后活动会话归属异常。" );
    results.push("真实 Codex 新会话可发送首条消息");

    stage = "Claude 模型与思考等级";
    await openClaude();
    const model = activeModel();
    await model.waitFor({ state: "visible", timeout: 10_000 });
    await model.selectOption("sonnet");
    await activeEffort().selectOption("medium");
    await activeInput().fill("/model");
    await activeInput().press("Escape");
    await activeInput().press("Enter");
    await modelResponse.first().waitFor({ state: "visible", timeout: 60_000 });
    assert(await model.inputValue() === "sonnet", "SDK 初始化后模型下拉框没有保持 Sonnet。" );
    results.push("真实 Claude 首条消息使用 Sonnet");

    const resumeMarker = `AGENTDESK_RESUME_${Date.now()}`;
    await activeInput().fill(`Reply with exactly this text and nothing else: ${resumeMarker}`);
    await activeInput().press("Enter");
    const persistedResponse = page.locator('.message-row.assistant', { hasText: resumeMarker });
    await persistedResponse.first().waitFor({ state: "visible", timeout: 60_000 });
    await page.locator(".pane-panel .stop-button").waitFor({ state: "hidden", timeout: 60_000 });

    stage = "Claude 上下文与压缩";
    const contextUsage = page.locator(".pane-panel .context-usage");
    await page.waitForFunction(() => {
      const text = document.querySelector(".pane-panel .context-usage")?.textContent?.trim() || "";
      const [used, total] = text.split("/");
      return Boolean(used && used !== "0" && total && total !== "?");
    }, null, { timeout: 60_000 });
    const compactButton = page.locator(".pane-panel .compact-count");
    await page.waitForFunction(() => {
      const button = document.querySelector(".pane-panel .compact-count");
      return button instanceof HTMLButtonElement && !button.disabled;
    }, null, { timeout: 30_000 });
    const compactBeforeText = (await compactButton.textContent())?.trim() || "";
    const compactBeforeCount = Number(compactBeforeText.match(/\d+/)?.[0] || 0);
    await compactButton.click({ force: true });
    await page.locator(".pane-panel .stop-button").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator(".pane-panel .stop-button").waitFor({ state: "hidden", timeout: 180_000 });
    const compactText = (await compactButton.textContent())?.trim() || "";
    const compactAfterCount = Number(compactText.match(/\d+/)?.[0] || -1);
    assert(compactAfterCount === compactBeforeCount || compactAfterCount === compactBeforeCount + 1, `Claude 压缩计数变化异常：${compactBeforeText} -> ${compactText}`);
    const postCompactMarker = "AGENTDESK_POST_COMPACT_" + Date.now();
    await activeInput().fill("Reply with exactly this text and nothing else: " + postCompactMarker);
    await activeInput().press("Enter");
    await page.locator(".message-row.assistant", { hasText: postCompactMarker }).first().waitFor({ state: "visible", timeout: 120_000 });
    await page.locator(".pane-panel .stop-button").waitFor({ state: "hidden", timeout: 120_000 });
    assert((await contextUsage.textContent())?.includes("/"), "Claude 上下文用量没有显示总量。" );
    results.push("真实 Claude 中等思考等级、上下文显示和压缩后继续发送可用");

    stage = "Claude 历史恢复";
    const activeClaudeTab = page.locator(".tab.active:has(.provider-mark.claude)");
    const uniqueTitle = `AgentDesk live resume ${Date.now()}`;
    await activeClaudeTab.click({ button: "right", force: true });
    await page.getByRole("menuitem", { name: "重命名" }).click({ force: true });
    const renameInput = page.getByRole("textbox", { name: "会话名称" });
    await renameInput.fill(uniqueTitle);
    await renameInput.press("Enter");
    await page.locator(".tab.active .tab-title", { hasText: uniqueTitle }).waitFor({ state: "visible", timeout: 15_000 });

    await activeClaudeTab.locator(".tab-close").click({ force: true });
    await page.waitForFunction(() => !document.querySelector(".tab.active .provider-mark.claude"));

    const historyEntry = sidebar.locator('.thread-item:has(.provider-mark.claude)', { hasText: uniqueTitle }).first();
    await historyEntry.waitFor({ state: "visible", timeout: 15_000 });
    await historyEntry.click();
    await persistedResponse.first().waitFor({ state: "visible", timeout: 45_000 });
    await page.locator(".pane-panel .compact-count", { hasText: `压缩 ${compactAfterCount}` }).waitFor({ state: "visible", timeout: 45_000 });
    assert(await modelResponse.count() === 0, "Claude 本地 /model 输出不应伪装成可恢复的历史消息。" );

    await activeInput().fill("/model");
    await activeInput().press("Escape");
    await activeInput().press("Enter");
    await modelResponse.first().waitFor({ state: "visible", timeout: 60_000 });
    await page.locator(".pane-panel .stop-button").waitFor({ state: "hidden", timeout: 60_000 });
    assert(await activeModel().inputValue() === "sonnet", "恢复会话后模型别名没有映射回 Sonnet。" );
    assert(await activeEffort().inputValue() === "medium", "恢复会话后思考等级没有保持 medium。" );

    stage = "Claude 图片输入";
    await activeInput().evaluate(async (element) => {
      const response = await fetch("/app-icon.png");
      const image = await response.blob();
      const transfer = new DataTransfer();
      transfer.items.add(new File([image], "agentdesk-icon.png", { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    try {
      await page.locator(".pane-panel .attachment-preview").waitFor({ state: "visible", timeout: 15_000 });
    } catch (error) {
      await failWithState("Claude 图片附件未出现", error);
    }
    const imageMarker = "AGENTDESK_IMAGE_" + Date.now();
    await activeInput().fill("Inspect the attached image, then reply with exactly this text and nothing else: " + imageMarker);
    await activeInput().press("Enter");
    await page.locator(".message-row.assistant", { hasText: imageMarker }).first().waitFor({ state: "visible", timeout: 120_000 });
    await page.locator(".pane-panel .stop-button").waitFor({ state: "hidden", timeout: 120_000 });
    assert(await page.locator(".pane-panel .attachment-preview").count() === 0, "Claude 图片发送后附件没有清空。" );
    results.push("真实 Claude 历史会话可恢复并继续发送");
    results.push("真实 Claude 图片输入可发送并得到回复");

    return { ok: true, results };
  } catch (error) {
    await failWithState(`真实 Provider 回归失败（${stage}）`, error);
  } finally {
    page.off("dialog", acceptDialog);
  }
}
