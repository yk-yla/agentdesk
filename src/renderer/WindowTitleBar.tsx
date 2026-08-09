import { Square, SquareStack, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { AgentBridge } from "../shared/protocol";

interface WindowTitleBarProps {
  bridge: AgentBridge;
}

function WindowTitleBar({ bridge }: WindowTitleBarProps) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let active = true;
    void bridge.getWindowState()
      .then((state) => {
        if (active) setMaximized(state.maximized);
      })
      .catch(() => undefined);
    const unsubscribe = bridge.onWindowState((state) => setMaximized(state.maximized));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);

  const toggleMaximize = () => {
    void bridge.toggleMaximizeWindow()
      .then((state) => setMaximized(state.maximized))
      .catch(() => undefined);
  };

  return <header className="window-titlebar">
    <div className="window-title">
      <img src="./app-icon.png" alt="" />
      <span>AgentDesk</span>
    </div>
    <div className="window-controls">
      <button
        type="button"
        className="window-control"
        onClick={toggleMaximize}
        title={maximized ? "还原窗口" : "最大化窗口"}
        aria-label={maximized ? "还原窗口" : "最大化窗口"}
      >
        {maximized ? <SquareStack size={14} /> : <Square size={14} />}
      </button>
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
