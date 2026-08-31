import { Download, FileDown, RefreshCw, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { ClaudeRuntimeStatus, CodexCliUpdateStatus, DesktopUpdateStatus, DiagnosticExport } from "../shared/protocol";
import { LIGHTWEIGHT_NOTICE_DURATION_MS } from "./sessionErrorNotice";
import { useAutoDismissNotice } from "./useAutoDismissNotice";

interface Props {
  status: DesktopUpdateStatus;
  cliStatus: CodexCliUpdateStatus;
  onCheck: () => Promise<void>;
  onDownload: () => Promise<void>;
  onInstall: () => Promise<void>;
  onOpenRepository?: () => Promise<void>;
  onCheckCli: () => Promise<void>;
  onUpdateCli: () => Promise<void>;
  claudeStatus: ClaudeRuntimeStatus;
  onCheckClaude: () => Promise<void>;
  onUpdateClaude: () => Promise<void>;
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

function sourceLabel(source?: string) {
  if (source === "npm") return "npm";
  if (source === "native") return "官方安装";
  if (source === "winget") return "winget";
  if (source === "managed") return "受管安装";
  if (source === "custom") return "自定义路径";
  return "未识别";
}

function errorKey(phase: string, message: string) {
  return phase === "error" ? `${phase}:${message}` : "";
}

function UpdateSettingsBase({ status, cliStatus, claudeStatus, onCheck, onDownload, onInstall, onCheckCli, onUpdateCli, onCheckClaude, onUpdateClaude, onExportDiagnostics }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cliBusy, setCliBusy] = useState(false);
  const [claudeBusy, setClaudeBusy] = useState(false);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnosticsNotice, setDiagnosticsNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [dismissedAppErrorKey, setDismissedAppErrorKey] = useState("");
  const [dismissedCliErrorKey, setDismissedCliErrorKey] = useState("");
  const [dismissedClaudeErrorKey, setDismissedClaudeErrorKey] = useState("");
  const diagnosticsAutoDismissProps = useAutoDismissNotice(
    diagnosticsNotice?.kind === "success" ? diagnosticsNotice.message : null,
    diagnosticsNotice?.kind === "success" ? LIGHTWEIGHT_NOTICE_DURATION_MS : null,
    () => setDiagnosticsNotice(null),
  );

  useEffect(() => { if (status.phase !== "error") setDismissedAppErrorKey(""); }, [status.phase]);
  useEffect(() => { if (cliStatus.phase !== "error") setDismissedCliErrorKey(""); }, [cliStatus.phase]);
  useEffect(() => { if (claudeStatus.phase !== "error") setDismissedClaudeErrorKey(""); }, [claudeStatus.phase]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败，请重试"); } finally { setBusy(false); }
  };
  const runCli = async (action: () => Promise<void>) => {
    if (cliBusy || cliStatus.phase === "checking" || cliStatus.phase === "updating") return;
    setCliBusy(true);
    try { await action(); } finally { setCliBusy(false); }
  };
  const runClaude = async (action: () => Promise<void>) => {
    if (claudeBusy || claudeStatus.phase === "checking" || claudeStatus.phase === "updating") return;
    setClaudeBusy(true);
    try { await action(); } finally { setClaudeBusy(false); }
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
  const cliBusyNow = cliBusy || cliStatus.phase === "checking" || cliStatus.phase === "updating";
  const claudeBusyNow = claudeBusy || claudeStatus.phase === "checking" || claudeStatus.phase === "updating";
  const appStatusErrorKey = errorKey(status.phase, status.message);
  const cliStatusErrorKey = errorKey(cliStatus.phase, cliStatus.message);
  const claudeStatusErrorKey = errorKey(claudeStatus.phase, claudeStatus.message);
  const appStatusErrorVisible = status.phase === "error" && dismissedAppErrorKey !== appStatusErrorKey;
  const cliStatusErrorVisible = cliStatus.phase === "error" && dismissedCliErrorKey !== cliStatusErrorKey;
  const claudeStatusErrorVisible = claudeStatus.phase === "error" && dismissedClaudeErrorKey !== claudeStatusErrorKey;

  return <div className="update-settings">
    <div className="settings-section-title">更新</div>
    <section className="update-row">
      <div className="update-row-product"><strong>AgentDesk</strong><span>v{status.currentVersion || "-"}</span></div>
      <div className="update-row-state">{error || status.phase !== "error" || appStatusErrorVisible ? <em className={status.phase}>{error || shortStatus(status.phase, status.message, status.availableVersion)}</em> : null}</div>
      <div className="update-row-actions">{error || appStatusErrorVisible ? <button type="button" className="bare-button" onClick={() => { setError(""); if (appStatusErrorKey) setDismissedAppErrorKey(appStatusErrorKey); }} title="关闭错误提示" aria-label="关闭错误提示"><X size={14} /></button> : null}{status.phase === "available" ? <button className="update-action primary" onClick={() => void run(onDownload)} disabled={appBusy}><Download size={13} />更新</button> : status.phase === "downloaded" ? <button className="update-action primary" onClick={install} disabled={busy}><RefreshCw size={13} />重启安装</button> : <button className="bare-button" onClick={() => void run(onCheck)} disabled={appBusy || status.phase === "unsupported"} title="检查 AgentDesk 更新" aria-label="检查 AgentDesk 更新"><RefreshCw className={status.phase === "checking" ? "spin" : ""} size={14} /></button>}</div>
    </section>
    <section className="update-row">
      <div className="update-row-product"><strong>Codex CLI</strong><span title={cliStatus.executablePath}>{cliStatus.currentVersion ? `v${cliStatus.currentVersion} · ${sourceLabel(cliStatus.installSource)}` : "未安装"}</span></div>
      <div className="update-row-state">{cliStatus.phase !== "error" || cliStatusErrorVisible ? <em className={cliStatus.phase}>{shortStatus(cliStatus.phase, cliStatus.message, cliStatus.latestVersion)}</em> : null}</div>
      <div className="update-row-actions">{cliStatusErrorVisible ? <button type="button" className="bare-button" onClick={() => setDismissedCliErrorKey(cliStatusErrorKey)} title="关闭错误提示" aria-label="关闭错误提示"><X size={14} /></button> : null}{cliStatus.phase === "available" ? <button className="update-action primary" onClick={() => void runCli(onUpdateCli)} disabled={cliBusyNow}><Download size={13} />更新</button> : <button className="bare-button" onClick={() => void runCli(onCheckCli)} disabled={cliBusyNow} title="检查 Codex CLI 更新" aria-label="检查 Codex CLI 更新"><RefreshCw className={cliStatus.phase === "checking" ? "spin" : ""} size={14} /></button>}</div>
    </section>
    <section className="update-row">
      <div className="update-row-product"><strong>Claude Code</strong><span title={claudeStatus.executablePath}>{claudeStatus.binaryVersion ? `v${claudeStatus.binaryVersion} · ${sourceLabel(claudeStatus.installSource)}` : "未安装"}</span></div>
      <div className="update-row-state">{claudeStatus.phase !== "error" || claudeStatusErrorVisible ? <em className={claudeStatus.phase}>{shortStatus(claudeStatus.phase, claudeStatus.message, claudeStatus.latestVersion)}</em> : null}</div>
      <div className="update-row-actions">{claudeStatusErrorVisible ? <button type="button" className="bare-button" onClick={() => setDismissedClaudeErrorKey(claudeStatusErrorKey)} title="关闭错误提示" aria-label="关闭错误提示"><X size={14} /></button> : null}{claudeStatus.phase === "available" ? <button className="update-action primary" onClick={() => void runClaude(onUpdateClaude)} disabled={claudeBusyNow}><Download size={13} />更新</button> : <button className="bare-button" onClick={() => void runClaude(onCheckClaude)} disabled={claudeBusyNow} title="检查 Claude Code 更新" aria-label="检查 Claude Code 更新"><RefreshCw className={claudeStatus.phase === "checking" ? "spin" : ""} size={14} /></button>}</div>
    </section>
    <details className="diagnostics-details">
      <summary>故障排查</summary>
      <div className="diagnostics-section"><button className="diagnostics-link" onClick={() => void exportDiagnostics()} disabled={diagnosticsBusy}><FileDown size={13} />{diagnosticsBusy ? "导出中" : "导出诊断日志"}</button>{diagnosticsNotice ? <><div className="diagnostics-message" title={diagnosticsNotice.message} {...diagnosticsAutoDismissProps}>{diagnosticsNotice.message}</div><button type="button" className="bare-button" onClick={() => setDiagnosticsNotice(null)} title="关闭提示" aria-label="关闭提示"><X size={13} /></button></> : null}</div>
    </details>
  </div>;
}

export default memo(UpdateSettingsBase);
