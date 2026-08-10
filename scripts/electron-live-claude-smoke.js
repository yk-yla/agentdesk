async page => {
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
    activeProvider: document.querySelector(".tab.active .provider-mark")?.className || "",
    activeStatus: document.querySelector(".pane-panel .status-label")?.textContent || "",
    context: document.querySelector(".pane-panel .context-usage")?.textContent || "",
    compact: document.querySelector(".pane-panel .compact-count")?.textContent || "",
    compactDisabled: (document.querySelector(".pane-panel .compact-count") instanceof HTMLButtonElement)
      ? document.querySelector(".pane-panel .compact-count").disabled
      : null,
    error: document.querySelector(".pane-panel .error-banner")?.textContent || "",
  }));
  const failWithState = async (message, error) => {
    throw new Error(`${message}：${JSON.stringify(await state())}；${error instanceof Error ? error.message : String(error)}`);
  };
  const sidebar = page.locator("aside.sidebar");
  const input = page.locator('.pane-panel textarea[aria-label="消息输入"]');
  const stop = page.locator(".pane-panel .stop-button");
  const openClaude = async () => {
    await sidebar.locator("button.provider-new-claude").first().click({ force: true });
    try {
      await page.waitForFunction(() => Boolean(document.querySelector(".tab.active .provider-mark.claude")), null, { timeout: 15_000 });
    } catch (error) {
      await failWithState("打开 Claude 会话失败", error);
    }
  };

  try {
    await page.evaluate(() => window.agentDesk.dev.setClaudeLifecycleFixture(null));
    await openClaude();
    const firstMarker = `AGENTDESK_CLAUDE_ONLY_${Date.now()}`;
    await input.fill(`Reply with exactly this text and nothing else: ${firstMarker}`);
    await input.press("Enter");
    try {
      await page.locator(".message-row.assistant", { hasText: firstMarker }).first().waitFor({ state: "visible", timeout: 120_000 });
      await stop.waitFor({ state: "hidden", timeout: 120_000 });
    } catch (error) {
      await failWithState("Claude 首轮真实回复失败", error);
    }
    assert((await state()).activeProvider.includes("claude"), "Claude 首轮结束后活动 Provider 不是 Claude。");

    try {
      await page.waitForFunction(() => {
        const text = document.querySelector(".pane-panel .context-usage")?.textContent?.trim() || "";
        const [used, total] = text.split("/");
        return Boolean(used && used !== "0" && total && total !== "?");
      }, null, { timeout: 60_000 });
    } catch (error) {
      await failWithState("Claude 上下文用量未更新", error);
    }

    const compact = page.locator(".pane-panel .compact-count");
    try {
      await page.waitForFunction(() => {
        const button = document.querySelector(".pane-panel .compact-count");
        return button instanceof HTMLButtonElement && !button.disabled;
      }, null, { timeout: 30_000 });
      assert((await state()).activeProvider.includes("claude"), "压缩按钮可用前活动 Provider 已切到其他 Provider。");
      await compact.click({ force: true });
      await stop.waitFor({ state: "visible", timeout: 15_000 });
      await stop.waitFor({ state: "hidden", timeout: 180_000 });
    } catch (error) {
      await failWithState("Claude 真实压缩失败", error);
    }
    assert((await state()).activeProvider.includes("claude"), "Claude 压缩结束后活动 Provider 不是 Claude。");

    const secondMarker = `AGENTDESK_CLAUDE_POST_COMPACT_${Date.now()}`;
    await input.fill(`Reply with exactly this text and nothing else: ${secondMarker}`);
    await input.press("Enter");
    try {
      await page.locator(".message-row.assistant", { hasText: secondMarker }).first().waitFor({ state: "visible", timeout: 120_000 });
      await stop.waitFor({ state: "hidden", timeout: 120_000 });
    } catch (error) {
      await failWithState("Claude 压缩后继续发送失败", error);
    }
    assert((await state()).activeProvider.includes("claude"), "Claude 压缩后回复结束时活动 Provider 不是 Claude。");
    return { ok: true, results: ["Claude 独立真实链通过"], finalState: await state() };
  } finally {
    page.off("dialog", acceptDialog);
  }
}
