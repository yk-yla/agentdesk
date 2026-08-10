import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
  message: string;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, message: "" };

  static getDerivedStateFromError(error: Error): State {
    return {
      failed: true,
      message: error.message.startsWith("AgentDesk 桥接加载失败") ? error.message : "",
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    void window.agentDesk?.writeLog({ level: "error", event: "renderer.react_error", details: { error: { name: error.name, message: error.message, stack: error.stack }, componentStack: info.componentStack } }).catch(() => undefined);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="error-boundary">
        <div className="error-boundary-content">
          <h1>{this.state.message ? "桌面连接失败" : "界面发生错误"}</h1>
          <p>{this.state.message || "会话数据仍由 Codex 保存，可以重新加载界面。"}</p>
          <button type="button" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      </main>
    );
  }
}
