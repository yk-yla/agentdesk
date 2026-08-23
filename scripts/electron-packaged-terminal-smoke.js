async page => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const cwd = await page.evaluate(() => window.agentDesk.getWorkspace());
  await page.evaluate(() => {
    window.__agentDeskTerminalEvents = [];
    window.agentDesk.onTerminalEvent((event) => window.__agentDeskTerminalEvents.push(event));
  });
  const readEvents = () => page.evaluate(() => window.__agentDeskTerminalEvents || []);
  const waitForEvent = async (type, sessionId, timeout = 15_000) => {
    await page.waitForFunction(({ expectedType, expectedSessionId }) => (
      (window.__agentDeskTerminalEvents || []).some((event) => event.type === expectedType && event.sessionId === expectedSessionId)
    ), { expectedType: type, expectedSessionId: sessionId }, { timeout });
    return (await readEvents()).find((event) => event.type === type && event.sessionId === sessionId);
  };
  const start = async (provider, sessionId) => {
    const info = await page.evaluate(async ({ providerName, terminalSessionId, workspace }) => (
      window.agentDesk.startTerminalSession({
        provider: providerName,
        sessionId: terminalSessionId,
        cwd: workspace,
        cols: 80,
        rows: 24,
      })
    ), { providerName: provider, terminalSessionId: sessionId, workspace: cwd });
    assert(info.provider === provider && info.sessionId === sessionId && info.status === "starting", provider + " 打包版终端启动返回值异常。");
    await waitForEvent("ready", sessionId);
    await page.evaluate(({ terminalSessionId, generation }) => (
      window.agentDesk.writeTerminalInput({ sessionId: terminalSessionId, generation, data: "AGENTDESK_TERMINAL_PING\r" })
    ), { terminalSessionId: sessionId, generation: info.generation });
    await page.waitForFunction(({ terminalSessionId }) => (
      (window.__agentDeskTerminalEvents || []).some((event) => event.type === "output" && event.sessionId === terminalSessionId && String(event.data || "").includes("AGENTDESK_TERMINAL_PONG"))
    ), { terminalSessionId: sessionId }, { timeout: 15_000 });
    await page.evaluate(({ terminalSessionId, generation }) => (
      window.agentDesk.resizeTerminal({ sessionId: terminalSessionId, generation, cols: 100, rows: 30 })
    ), { terminalSessionId: sessionId, generation: info.generation });
    await page.evaluate(({ terminalSessionId, generation }) => (
      window.agentDesk.closeTerminal({ sessionId: terminalSessionId, generation })
    ), { terminalSessionId: sessionId, generation: info.generation });
    const exited = await waitForEvent("exited", sessionId);
    assert(exited && exited.info && exited.info.status === "exited", provider + " 打包版终端退出事件无效。");
    return { provider, generation: info.generation, pid: info.pid };
  };
  const results = [
    await start("claude", "package-terminal-claude"),
    await start("codex", "package-terminal-codex"),
  ];
  const finalEvents = await readEvents();
  assert(finalEvents.filter((event) => event.type === "ready").length >= 2, "打包版两个 Provider 均未收到 ready 事件。");
  assert(finalEvents.filter((event) => event.type === "exited").length >= 2, "打包版两个 Provider 均未收到 exited 事件。");
  return { ok: true, results, eventTypes: finalEvents.map((event) => event.provider + ":" + event.type) };
}
