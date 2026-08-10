import { memo, useState, type CSSProperties } from "react";
import type { AgentProvider } from "../shared/agentProtocol";

const CODEX_MASK_STYLE: CSSProperties = {
  WebkitMaskImage: 'url("./providers/codex.ico")',
  maskImage: 'url("./providers/codex.ico")',
};

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
    {failed
      ? <span className="provider-mark-fallback">{label ? name : fallback}</span>
      : provider === "codex"
        ? <><img className="provider-mark-source" src="./providers/codex.ico" alt="" onError={() => setFailed(true)} /><span className="provider-mark-monochrome" style={CODEX_MASK_STYLE} aria-hidden="true" /></>
        : <img src="./providers/claude.ico" alt="" onError={() => setFailed(true)} />}
  </span>;
}

export default memo(ProviderIconBase);
