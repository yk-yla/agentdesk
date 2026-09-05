import type { AgentProvider } from "../shared/agentProtocol";
import type { SessionState } from "./domain";

export function recoverProviderSessions(sessions: Record<string, SessionState>, provider: AgentProvider, affectedSessionIds?: ReadonlySet<string>) {
  const providerName = provider === "claude" ? "Claude Code" : "Codex";
  return Object.fromEntries(Object.entries(sessions).map(([id, session]) => session.provider === provider && (!affectedSessionIds || affectedSessionIds.has(id)) ? [id, {
    ...session,
    resumed: false,
    status: "error" as const,
    statusLabel: `${providerName} 服务已断开`,
    activeTurnId: null,
    startedAt: null,
    queryGeneration: 0,
    pendingApprovals: [],
    messages: session.messages.some((message) => message.streaming)
      ? session.messages.map((message) => message.streaming ? { ...message, streaming: false } : message)
      : session.messages,
    errorText: `${providerName} 服务异常退出，未完成的追加任务已保留，请重新发送或关闭此提示后重试。`,
    plan: session.plan ? {
      ...session.plan,
      steps: session.plan.steps.map((step) => step.status === "inProgress" ? { ...step, status: "pending" as const } : step),
      updatedAt: Date.now(),
    } : null,
  }] : [id, session])) as Record<string, SessionState>;
}
