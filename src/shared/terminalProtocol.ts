import type { AgentProvider } from "./agentProtocol";

export type TerminalSessionStatus = "starting" | "running" | "exited" | "closing" | "failed";

export interface TerminalSessionRequest {
  provider: AgentProvider;
  sessionId: string;
  cwd: string;
  nativeSessionId?: string;
  cols?: number;
  rows?: number;
  resume?: boolean;
}

export interface TerminalSessionInfo {
  provider: AgentProvider;
  sessionId: string;
  cwd: string;
  nativeSessionId?: string;
  generation: number;
  pid: number;
  status: TerminalSessionStatus;
}

export interface TerminalInputRequest {
  sessionId: string;
  generation: number;
  data: string;
}

export interface TerminalResizeRequest {
  sessionId: string;
  generation: number;
  cols: number;
  rows: number;
}

export interface TerminalSessionCommand {
  sessionId: string;
  generation?: number;
}

export type TerminalEventType = "started" | "ready" | "output" | "exited" | "error";

export interface TerminalEvent {
  provider: AgentProvider;
  sessionId: string;
  generation: number;
  type: TerminalEventType;
  receivedAt: number;
  info?: TerminalSessionInfo;
  data?: string;
  exitCode?: number;
  signal?: number;
  message?: string;
}
