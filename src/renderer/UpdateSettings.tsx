import { Download, FileDown, RefreshCw, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { DesktopUpdateStatus, DiagnosticExport } from "../shared/protocol";
import { LIGHTWEIGHT_NOTICE_DURATION_MS } from "./sessionErrorNotice";
import { useAutoDismissNotice } from "./useAutoDismissNotice";

interface Props {
  status: DesktopUpdateStatus;
  onCheck: () => Promise<void>;
  onDownload: () => Promise<void>;
  onInstall: () => Promise<void>;
  onOpenRepository?: () => Promise<void>;
  onExportDiagnostics: () => Promise<DiagnosticExport | null>;
}

function shortStatus(phase: string, message: string, availableVersion?: string) {
  if (phase === "available") return `有新版 v${availableVersion || ""}`.trim();
  if (phase === "upToDate") return "已是最新版本";
  if (phase === "checking") return "检查中…";
  if (phase === "updating") return "更新中…";
  if (phase === "downloaded") return "新版已下载";
  if (phase === "notInstalled") return "未安装";
  if (phase === "unsupported") return "当前版本不支持更新";
  if (phase === "error") return message || "检查失败，请稍后重试";
  return message || "尚未检查";
}

function UpdateSettingsBase({ status, onCheck, onDownload, onInstall, onExportDiagnostics }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnosticsNotice, setDiagnosticsNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [dismissedAppErrorKey, setDismissedAppErrorKey] = useState("");
  const diagnosticsAutoDismissProps = useAutoDismissNotice(
    diagnosticsNotice?.kind === "success" ? diagnosticsNotice.message : null,
    diagnosticsNotice?.kind === "success" ? LIGHTWEIGHT_NOTICE_DURATION_MS : null,
    () => setDiagnosticsNotice(null),
  );

  useEffect(() => { if (status.phase !== "error") setDismissedAppErrorKey(""); }, [status.phase]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败，请重试"); } finally { setBusy(false); }
  };
  const install = () => {
    if (!window.confirm("软件将自动安装并重启。确定现在安装吗？")) return;
    void run(onInstall);
  };
  const exportDiagnostics = async () => {
    if (diagnosticsBusy) return;
    setDiagnosticsBusy(true); setDiagnosticsNotice(null);
    try {
      const result = await onExportDiagnostics();
      if (result) setDiagnosticsNotice({ kind: "success", message: `已导出：${result.path}` });
    } catch (reason) { setDiagnosticsNotice({ kind: "error", message: reason instanceof Error ? reason.message : "导出失败，请重试" }); }
    finally { setDiagnosticsBusy(false); }
  };

  const appBusy = busy || status.phase === "checking" || status.phase === "downloading";
  const appStatusErrorKey = status.phase === "error" ? `${status.phase}:${status.message}` : "";
  const appStatusErrorVisible = status.phase === "error" && dismissedAppErrorKey !== appStatusErrorKey;

  return <div className="update-settings">
    <div className="settings-section-title">更新</div>
    <section className="update-row">
      <div className="update-row-product"><strong>AgentDesk</strong><span>v{status.currentVersion || "-"}</span></div>
      <div className="update-row-state">{error || status.phase !== "error" || appStatusErrorVisible ? <em className={status.phase}>{error || shortStatus(status.phase, status.message, status.availableVersion)}</em> : null}</div>
      <div className="update-row-actions">{error || appStatusErrorVisible ? <button type="button" className="bare-button" onClick={() => { setError(""); if (appStatusErrorKey) setDismissedAppErrorKey(appStatusErrorKey); }} title="关闭错误提示" aria-label="关闭错误提示"><X size={14} /></button> : null}{status.phase === "available" ? <button className="update-action primary" onClick={() => void run(onDownload)} disabled={appBusy}><Download size={13} />更新</button> : status.phase === "downloaded" ? <button className="update-action primary" onClick={install} disabled={busy}><RefreshCw size={13} />重启安装</button> : <button className="bare-button" onClick={() => void run(onCheck)} disabled={appBusy || status.phase === "unsupported"} title="检查 AgentDesk 更新" aria-label="检查 AgentDesk 更新"><RefreshCw className={status.phase === "checking" ? "spin" : ""} size={14} /></button>}</div>
    </section>
    <details className="diagnostics-details">
      <summary>故障排查</summary>
      <div className="diagnostics-section"><button className="diagnostics-link" onClick={() => void exportDiagnostics()} disabled={diagnosticsBusy}><FileDown size={13} />{diagnosticsBusy ? "导出中" : "导出诊断日志"}</button>{diagnosticsNotice ? <><div className="diagnostics-message" title={diagnosticsNotice.message} {...diagnosticsAutoDismissProps}>{diagnosticsNotice.message}</div><button type="button" className="bare-button" onClick={() => setDiagnosticsNotice(null)} title="关闭提示" aria-label="关闭提示"><X size={13} /></button></> : null}</div>
    </details>
  </div>;
}

export default memo(UpdateSettingsBase);
