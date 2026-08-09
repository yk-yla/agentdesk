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
  const modelResponse = page.locator('.message-row.assistant', { hasText: "Current model: Sonnet" });

  try {
    await page.evaluate(() => window.agentDesk.dev.setClaudeLifecycleFixture(null));
    await sidebar.locator("button.provider-new-codex").first().click({ force: true });
    const codexMarker = `AGENTDESK_CODEX_${Date.now()}`;
    await activeInput().fill(`Reply with exactly this text and nothing else: ${codexMarker}`);
    await activeInput().press("Enter");
    await page.locator('.message-row.assistant', { hasText: codexMarker }).first().waitFor({ state: "visible", timeout: 120_000 });
    await page.locator(".pane-panel .stop-button").waitFor({ state: "hidden", timeout: 120_000 });
    assert(await page.locator(".tab.active .provider-mark.codex").count() === 1, "Codex 首条消息后活动会话归属异常。" );
    results.push("真实 Codex 新会话可发送首条消息");

    await sidebar.locator("button.provider-new-claude").first().click({ force: true });
    const model = activeModel();
    await model.waitFor({ state: "visible", timeout: 10_000 });
    await model.selectOption("sonnet");
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

    const activeClaudeTab = page.locator(".tab.active:has(.provider-mark.claude)");
    const uniqueTitle = `AgentDesk live resume ${Date.now()}`;
    await activeClaudeTab.click({ button: "right", force: true });
    await page.getByRole("menuitem", { name: "重命名" }).click();
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
    assert(await modelResponse.count() === 0, "Claude 本地 /model 输出不应伪装成可恢复的历史消息。" );

    await activeInput().fill("/model");
    await activeInput().press("Escape");
    await activeInput().press("Enter");
    await modelResponse.first().waitFor({ state: "visible", timeout: 60_000 });
    await page.locator(".pane-panel .stop-button").waitFor({ state: "hidden", timeout: 60_000 });
    assert(await activeModel().inputValue() === "sonnet", "恢复会话后模型别名没有映射回 Sonnet。" );
    results.push("真实 Claude 历史会话可恢复并继续发送");

    return { ok: true, results };
  } finally {
    page.off("dialog", acceptDialog);
  }
}
