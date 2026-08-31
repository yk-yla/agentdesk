import { X } from "lucide-react";
import { memo } from "react";
import type { AgentBridge } from "../shared/protocol";

interface WindowTitleBarProps {
  bridge: AgentBridge;
}

function WindowTitleBar({ bridge }: WindowTitleBarProps) {
  return <header className="window-titlebar">
    <div className="window-title">
      <img src="./app-icon.png" alt="" />
      <span>AgentDesk</span>
    </div>
    <div className="window-controls">
      <button
        type="button"
        className="window-control window-close"
        onClick={() => void bridge.minimizeWindow().catch(() => undefined)}
        title="最小化到任务栏"
        aria-label="最小化到任务栏"
      >
        <X size={16} />
      </button>
    </div>
  </header>;
}

export default memo(WindowTitleBar);
