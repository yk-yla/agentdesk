import type { AgentOperation } from "../shared/agentProtocol";

const TERMINAL_HISTORY_OPERATIONS = new Set<AgentOperation>([
  "readSession", "forkSession", "renameSession", "deleteSession", "updateSessionMetadata",
]);

export interface TerminalHistorySession {
  provider?: "codex" | "claude";
  presentationMode: "workbench" | "terminal";
  threadId: string | null;
  readOnly?: boolean;
}

/**
 * 内置终端不登记为普通 Agent 会话；历史操作必须按原生会话身份请求。
 */
export function shouldUseTerminalHistoryRequest(session: TerminalHistorySession | undefined, operation: AgentOperation) {
  const terminalSession = session?.presentationMode === "terminal";
  const externalClaudeSession = session?.provider === "claude" && session.readOnly === true;
  return (terminalSession || externalClaudeSession) && Boolean(session.threadId) && TERMINAL_HISTORY_OPERATIONS.has(operation);
}
