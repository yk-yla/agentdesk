import { memo, useState } from "react";
import type { AgentProvider } from "../shared/agentProtocol";

interface Props {
  provider: AgentProvider;
  size?: number;
  label?: boolean;
}

function ProviderIconBase({ provider, size = 15, label = false }: Props) {
  const [failed, setFailed] = useState(false);
  const name = provider === "codex" ? "Codex" : "Claude Code";
  const fallback = provider === "codex" ? "CX" : "CC";
  return <span className={`provider-mark ${provider}`} title={name} aria-label={name} style={{ width: size, height: size }}>
    {failed ? <span className="provider-mark-fallback">{label ? name : fallback}</span> : <img src={`./providers/${provider}.ico`} alt="" onError={() => setFailed(true)} />}
  </span>;
}

export default memo(ProviderIconBase);
