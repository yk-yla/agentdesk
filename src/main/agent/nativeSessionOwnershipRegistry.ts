import type { AgentProvider } from "../../shared/agentProtocol";

export interface NativeSessionOwner {
  provider: AgentProvider;
  nativeSessionId: string;
  clientSessionId: string;
}

export class NativeSessionOwnershipRegistry {
  private readonly owners = new Map<string, NativeSessionOwner>();

  assertAvailable(provider: AgentProvider, nativeSessionId: string, clientSessionId: string) {
    const owner = this.owners.get(this.key(provider, nativeSessionId));
    if (owner && owner.clientSessionId !== clientSessionId) {
      throw new Error("原生会话已被其他客户端会话占用。");
    }
  }

  claim(provider: AgentProvider, nativeSessionId: string, clientSessionId: string) {
    this.assertAvailable(provider, nativeSessionId, clientSessionId);
    this.owners.set(this.key(provider, nativeSessionId), { provider, nativeSessionId, clientSessionId });
  }

  owner(provider: AgentProvider, nativeSessionId: string) {
    return this.owners.get(this.key(provider, nativeSessionId));
  }

  release(provider: AgentProvider, nativeSessionId: string, clientSessionId: string) {
    const key = this.key(provider, nativeSessionId);
    const owner = this.owners.get(key);
    if (owner?.clientSessionId === clientSessionId) this.owners.delete(key);
  }

  clearProvider(provider: AgentProvider) {
    for (const [key, owner] of this.owners) {
      if (owner.provider === provider) this.owners.delete(key);
    }
  }

  private key(provider: AgentProvider, nativeSessionId: string) {
    return provider + "\u0000" + nativeSessionId;
  }
}
