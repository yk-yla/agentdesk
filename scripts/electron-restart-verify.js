async page => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const leftDraft = "AgentDesk restart left draft";
  const rightDraft = "AgentDesk restart right draft - forced snapshot";
  await page.locator("aside.sidebar").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(({ left, right }) => {
    const panes = Array.from(document.querySelectorAll(".pane-panel:not(.inactive-tab)"));
    const drafts = panes.map((pane) => pane.querySelector('textarea[aria-label="消息输入"]')?.value || "");
    return panes.length === 2 && drafts[0] === left && drafts[1] === right;
  }, { left: leftDraft, right: rightDraft }, { timeout: 20_000 });

  const state = await page.evaluate(async () => {
    const preferences = await window.agentDesk.getPreferences();
    const panes = Array.from(document.querySelectorAll(".pane-panel:not(.inactive-tab)"));
    return {
      paneCount: panes.length,
      tabCounts: Array.from(document.querySelectorAll(".pane-tab-group")).map((group) => group.querySelectorAll(".tab").length),
      activePaneIndex: panes.findIndex((pane) => pane.classList.contains("active-pane")),
      drafts: panes.map((pane) => pane.querySelector('textarea[aria-label="消息输入"]')?.value || ""),
      collapsed: document.querySelector("aside.sidebar")?.classList.contains("collapsed") === true,
      workingTabs: document.querySelectorAll(".tab-status.working").length,
      savedPaneCount: Array.isArray(preferences.workspaceState?.layout?.panes) ? preferences.workspaceState.layout.panes.length : 0,
      savedSessionCount: Array.isArray(preferences.workspaceState?.sessions) ? preferences.workspaceState.sessions.length : 0,
    };
  });
  assert(state.paneCount === 2, `重启后栏数不正确：${state.paneCount}`);
  assert(JSON.stringify(state.tabCounts) === JSON.stringify([2, 1]), `重启后 Tab 分布不正确：${JSON.stringify(state.tabCounts)}`);
  assert(state.activePaneIndex === 1, `重启后活动栏不正确：${state.activePaneIndex}`);
  assert(JSON.stringify(state.drafts) === JSON.stringify([leftDraft, rightDraft]), `重启后草稿不正确：${JSON.stringify(state.drafts)}`);
  assert(state.collapsed, "重启后侧栏收起状态丢失。");
  assert(state.workingTabs === 0, "重启后仍有会话伪装成正在运行。");
  assert(state.savedPaneCount === 2 && state.savedSessionCount === 3, "恢复成功后现场快照被清空或不完整。");
  const restoredTitle = "AgentDesk restart content fixture";
  const restoredContent = "AgentDesk restart restored content";
  const restoredTab = page.locator(".tab", { hasText: restoredTitle }).first();
  await restoredTab.waitFor({ state: "visible", timeout: 15_000 });
  await restoredTab.click();
  await page.waitForFunction((content) => Array.from(document.querySelectorAll(".message-row")).some((row) => row.textContent?.includes(content)), restoredContent, { timeout: 15_000 });
  return { ok: true, results: ["两栏与活动栏已恢复", "三个 Tab 已恢复", "两个草稿已恢复", "历史消息已自动恢复", "侧栏状态已恢复", "现场快照恢复后继续保留"] };
}
