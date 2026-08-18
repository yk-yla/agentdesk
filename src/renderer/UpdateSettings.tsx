import { Download, ExternalLink, FileDown, RefreshCw } from "lucide-react";
import { memo, useState } from "react";
import type { ClaudeRuntimeStatus, CodexCliUpdateStatus, DesktopUpdateStatus, DiagnosticExport } from "../shared/protocol";

interface Props {
  status: DesktopUpdateStatus;
  cliStatus: CodexCliUpdateStatus;
  onCheck: () => Promise<void>;
  onDownload: () => Promise<void>;
  onInstall: () => Promise<void>;
  onOpenRepository: () => Promise<void>;
  onCheckCli: () => Promise<void>;
  onUpdateCli: () => Promise<void>;
  claudeStatus: ClaudeRuntimeStatus;
  onCheckClaude: () => Promise<void>;
  onUpdateClaude: () => Promise<void>;
  onExportDiagnostics: () => Promise<DiagnosticExport | null>;
}

function formatCheckTime(value?: number) {
  return value ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(value) : "-";
}

function UpdateSettingsBase({ status, cliStatus, claudeStatus, onCheck, onDownload, onInstall, onOpenRepository, onCheckCli, onUpdateCli, onCheckClaude, onUpdateClaude, onExportDiagnostics }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cliBusy, setCliBusy] = useState(false);
  const [cliError, setCliError] = useState("");
  const [claudeBusy, setClaudeBusy] = useState(false);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnosticsMessage, setDiagnosticsMessage] = useState("");

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const install = () => {
    if (!window.confirm("软件将自动安装并重启。正在运行的任务会停止，其他可恢复状态会在重启后恢复。确定现在安装吗？")) return;
    void run(onInstall);
  };

  const checking = status.phase === "checking";
  const downloading = status.phase === "downloading";
  const unsupported = status.phase === "unsupported";
  const cliChecking = cliStatus.phase === "checking";
  const cliUpdating = cliStatus.phase === "updating";
  const cliWorking = cliChecking || cliUpdating || cliBusy;

  const runCli = async (action: () => Promise<void>) => {
    if (cliWorking) return;
    setCliBusy(true);
    setCliError("");
    try {
      await action();
    } catch (reason) {
      setCliError(reason instanceof Error ? reason.message : "操作失败，请重试。");
    } finally {
      setCliBusy(false);
    }
  };

  const canRetryCliUpdate = cliStatus.phase === "error" && Boolean(cliStatus.latestVersion) && cliStatus.latestVersion !== cliStatus.currentVersion;
  const claudeUpdating = claudeBusy || claudeStatus.phase === "checking" || claudeStatus.phase === "updating";
  const claudeAvailable = claudeStatus.phase === "available";

  const runClaude = async (action: () => Promise<void>) => {
    if (claudeUpdating) return;
    setClaudeBusy(true);
    try { await action(); } finally { setClaudeBusy(false); }
  };

  const exportDiagnostics = async () => {
    if (diagnosticsBusy) return;
    setDiagnosticsBusy(true);
    setDiagnosticsMessage("");
    try {
      const result = await onExportDiagnostics();
      if (result) setDiagnosticsMessage(`已导出：${result.path}`);
    } catch (reason) {
      setDiagnosticsMessage(reason instanceof Error ? reason.message : "导出失败，请重试。");
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  return <div className="update-settings">
    <section className="cli-update-section">
      <div className="update-heading"><strong>Codex CLI</strong><span>{cliStatus.currentVersion ? `v${cliStatus.currentVersion}` : "未安装"}</span></div>
      <div className="cli-version-row">
        <span>{cliStatus.latestVersion ? `最新 v${cliStatus.latestVersion}` : "最新版本待检查"}</span>
        <button className="bare-button" onClick={() => void runCli(onCheckCli)} disabled={cliWorking} title="刷新 Codex CLI 版本" aria-label="刷新 Codex CLI 版本"><RefreshCw className={cliChecking ? "spin" : ""} size={12} /></button>
      </div>
      <div className={`update-status cli-status ${cliStatus.phase}`}>{cliError || cliStatus.message}</div>
      {cliStatus.phase === "available" || canRetryCliUpdate
        ? <button className="update-action primary cli-update-action" onClick={() => void runCli(onUpdateCli)} disabled={cliWorking}><Download size={13} />{canRetryCliUpdate ? "重试更新" : `更新到 v${cliStatus.latestVersion}`}</button>
        : cliUpdating ? <button className="update-action primary cli-update-action" disabled><RefreshCw className="spin" size={13} />更新中</button> : null}
      <div className="cli-check-meta"><span>上次 {formatCheckTime(cliStatus.checkedAt)}</span><span>下次 {formatCheckTime(cliStatus.nextCheckAt)}</span></div>
    </section>
    <section className="claude-runtime-section">
      <div className="update-heading"><strong>Claude Code</strong><span>{claudeStatus.binaryVersion ? `v${claudeStatus.binaryVersion}` : "未检测到受管二进制"}</span></div>
      <div className="cli-version-row"><span>Agent SDK {claudeStatus.sdkVersion || "-"} · {claudeStatus.binarySource === "managed" ? "受管二进制" : "SDK 随包二进制"}</span><button className="bare-button" onClick={() => void runClaude(onCheckClaude)} disabled={claudeUpdating} title="刷新 Claude Code 版本" aria-label="刷新 Claude Code 版本"><RefreshCw className={claudeStatus.phase === "checking" ? "spin" : ""} size={12} /></button></div>
      <div className={`update-status ${claudeStatus.phase}`}>{claudeStatus.message}</div>
      <div className={`update-status ${claudeStatus.credentialsAvailable ? "ready" : "error"}`}>{claudeStatus.credentialMessage}</div>
      {claudeAvailable ? <button className="update-action primary" onClick={() => void runClaude(onUpdateClaude)} disabled={claudeUpdating}><Download size={13} />更新到 v{claudeStatus.latestVersion}</button> : null}
      <div className="cli-check-meta"><span>上次 {formatCheckTime(claudeStatus.checkedAt)}</span></div>
    </section>
    <section className="desktop-update-section">
      <div className="update-heading"><strong>软件更新</strong><span>v{status.currentVersion || "-"}</span></div>
      <div className="update-auth-row">
        <span>更新来源：公开 GitHub 仓库</span>
        <button className="bare-button" onClick={() => void run(onOpenRepository)} title="打开更新仓库" aria-label="打开更新仓库"><ExternalLink size={12} /></button>
      </div>
      <div className={`update-status ${status.phase}`}>{error || status.message}</div>
      {status.releaseNotes?.length ? <div className="release-notes" aria-label="更新内容">{status.releaseNotes.map((release) => <article className="release-note" key={`${release.version}-${release.note.slice(0, 20)}`}><strong>v{release.version}</strong><div>{release.note || "暂无更新说明。"}</div></article>)}</div> : null}
      {status.phase === "available" ? <button className="update-action" onClick={() => void run(onDownload)} disabled={busy}><Download size={13} />下载 v{status.availableVersion}</button>
        : status.phase === "downloaded" ? <button className="update-action primary" onClick={install} disabled={busy}><RefreshCw size={13} />重启安装</button>
          : <button className="update-action" onClick={() => void run(onCheck)} disabled={busy || checking || downloading || unsupported}><RefreshCw className={checking ? "spin" : ""} size={13} />{downloading ? `下载中 ${status.progress || 0}%` : checking ? "检查中" : unsupported ? "仅安装版可用" : "检查更新"}</button>}
    </section>
    <section className="diagnostics-section">
      <div className="update-heading"><strong>故障排查</strong><span>仅本地导出</span></div>
      <button className="update-action" onClick={() => void exportDiagnostics()} disabled={diagnosticsBusy}><FileDown size={13} />{diagnosticsBusy ? "导出中" : "导出诊断日志"}</button>
      {diagnosticsMessage ? <div className="update-status ready" title={diagnosticsMessage}>{diagnosticsMessage}</div> : null}
    </section>
  </div>;
}

export default memo(UpdateSettingsBase);
