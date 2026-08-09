import type { AgentBridge } from "../shared/protocol";

declare global {
  interface Window {
    agentDesk?: AgentBridge;
  }
}

export {};
