async page => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const sidebar = page.locator("aside.sidebar");
  await sidebar.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll(".pane-panel:not(.inactive-tab)").length === 1 && Boolean(document.querySelector('.pane-panel:not(.inactive-tab) textarea[aria-label="消息输入"]')), null, { timeout: 15_000 });

  const restoredTitle = "AgentDesk restart content fixture";
  const restoredContent = "AgentDesk restart restored content";
  const restoredHistory = sidebar.locator(".thread-item", { hasText: restoredTitle }).first();
  await restoredHistory.waitFor({ state: "visible", timeout: 15_000 });
  await restoredHistory.click({ force: true });
  await page.waitForFunction((content) => Array.from(document.querySelectorAll(".message-row")).some((row) => row.textContent?.includes(content)), restoredContent, { timeout: 15_000 });

  const initialTabCount = await page.locator(".tab").count();
  await sidebar.locator(".current-workspace .provider-new-codex").click({ force: true });
  await page.waitForFunction((previousCount) => document.querySelectorAll(".tab").length === previousCount + 1, initialTabCount, { timeout: 15_000 });
  const leftDraft = "AgentDesk restart left draft";
  await page.locator('.pane-panel.active-pane:not(.inactive-tab) textarea[aria-label="消息输入"]').fill(leftDraft);

  await sidebar.getByRole("button", { name: "分成两列" }).click({ force: true });
  await page.waitForFunction(() => document.querySelectorAll(".pane-panel:not(.inactive-tab)").length === 2
    && document.querySelector(".app-shell")?.getAttribute("data-pane-count") === "2"
    && Boolean(document.querySelector(".pane-panel.active-pane[data-empty-pane]")), null, { timeout: 15_000 });
  assert(await page.locator(".tab").count() === initialTabCount + 1, "分栏操作不应自动创建会话。");
  await page.locator('.pane-panel.active-pane[data-empty-pane] button[title="新建 Codex 会话"]').click();
  await page.waitForFunction(() => Boolean(document.querySelector('.pane-panel.active-pane:not(.inactive-tab) textarea[aria-label="消息输入"]')), null, { timeout: 15_000 });
  const panes = page.locator(".pane-panel:not(.inactive-tab)");
  const rightDraft = "AgentDesk restart right draft - forced snapshot";
  await panes.nth(1).locator('textarea[aria-label="消息输入"]').fill(rightDraft);
  await sidebar.getByRole("button", { name: "收起左侧面板" }).click({ force: true });
  await page.waitForFunction(() => document.querySelector("aside.sidebar")?.classList.contains("collapsed"), null, { timeout: 10_000 });

  const state = await page.evaluate(() => ({
    paneCount: document.querySelectorAll(".pane-panel:not(.inactive-tab)").length,
    tabCounts: Array.from(document.querySelectorAll(".pane-tab-group")).map((group) => group.querySelectorAll(".tab").length),
    activePaneIndex: Array.from(document.querySelectorAll(".pane-panel:not(.inactive-tab)")).findIndex((pane) => pane.classList.contains("active-pane")),
    drafts: Array.from(document.querySelectorAll('.pane-panel:not(.inactive-tab) textarea[aria-label="消息输入"]')).map((input) => input.value),
    collapsed: document.querySelector("aside.sidebar")?.classList.contains("collapsed") === true,
  }));
  assert(state.paneCount === 2, "退出前没有形成两栏。");
  assert(JSON.stringify(state.tabCounts) === JSON.stringify([2, 1]), `退出前 Tab 分布不正确：${JSON.stringify(state.tabCounts)}`);
  assert(state.activePaneIndex === 1, `退出前活动栏不正确：${state.activePaneIndex}`);
  assert(JSON.stringify(state.drafts) === JSON.stringify([leftDraft, rightDraft]), `退出前草稿不正确：${JSON.stringify(state.drafts)}`);
  assert(state.collapsed, "退出前侧栏没有收起。");
  return { ok: true, state: { ...state, restoredContentLoaded: true } };
}
