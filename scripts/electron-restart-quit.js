async page => {
  const hasQuitFixture = await page.evaluate(() => Boolean(window.agentDesk?.dev?.quitForTesting));
  if (!hasQuitFixture) throw new Error("开发版退出测试入口不可用。");
  await page.evaluate(() => {
    window.setTimeout(() => { void window.agentDesk.dev.quitForTesting(); }, 100);
  });
  return { ok: true, results: ["已请求 AgentDesk 正常退出"] };
}
