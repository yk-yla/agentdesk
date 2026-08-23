import type { AgentProvider } from "../../shared/agentProtocol";

export type NativeSessionMode = "workbench" | "terminal";

export interface NativeSessionOwner {
  provider: AgentProvider;
  nativeSessionId: string;
  clientSessionId: string;
  mode: NativeSessionMode;
}

export class NativeSessionOwnershipRegistry {
  private readonly owners = new Map<string, NativeSessionOwner>();

  assertAvailable(provider: AgentProvider, nativeSessionId: string, clientSessionId: string, mode: NativeSessionMode) {
    const owner = this.owners.get(this.key(provider, nativeSessionId));
    if (owner && owner.clientSessionId !== clientSessionId) {
      throw new Error("原生会话已被其他客户端会话占用。");
    }
  }

  claim(provider: AgentProvider, nativeSessionId: string, clientSessionId: string, mode: NativeSessionMode) {
    this.assertAvailable(provider, nativeSessionId, clientSessionId, mode);
    this.owners.set(this.key(provider, nativeSessionId), { provider, nativeSessionId, clientSessionId, mode });
  }

  owner(provider: AgentProvider, nativeSessionId: string) {
    return this.owners.get(this.key(provider, nativeSessionId));
  }

  release(provider: AgentProvider, nativeSessionId: string, clientSessionId: string, mode: NativeSessionMode) {
    const key = this.key(provider, nativeSessionId);
    const owner = this.owners.get(key);
    if (owner?.clientSessionId === clientSessionId && owner.mode === mode) this.owners.delete(key);
  }

  clearProvider(provider: AgentProvider, mode?: NativeSessionMode) {
    for (const [key, owner] of this.owners) {
      if (owner.provider === provider && (!mode || owner.mode === mode)) this.owners.delete(key);
    }
  }

  private key(provider: AgentProvider, nativeSessionId: string) {
    return provider + "\u0000" + nativeSessionId;
  }
}
