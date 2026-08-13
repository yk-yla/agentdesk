import { Download, ExternalLink, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { memo, useState } from "react";
import type { ClaudeRuntimeStatus, CodexCliUpdateStatus, DesktopUpdateStatus } from "../shared/protocol";

interface Props {
  status: DesktopUpdateStatus;
  cliStatus: CodexCliUpdateStatus;
  onSaveToken: (token: string) => Promise<void>;
  onClearToken: () => Promise<void>;
  onCheck: () => Promise<void>;
  onDownload: () => Promise<void>;
  onInstall: () => Promise<void>;
  onOpenTokenPage: () => Promise<void>;
  onCheckCli: () => Promise<void>;
  onUpdateCli: () => Promise<void>;
  claudeStatus: ClaudeRuntimeStatus;
  onCheckClaude: () => Promise<void>;
  onUpdateClaude: () => Promise<void>;
}

function formatCheckTime(value?: number) {
  return value ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(value) : "-";
}

function UpdateSettingsBase({ status, cliStatus, claudeStatus, onSaveToken, onClearToken, onCheck, onDownload, onInstall, onOpenTokenPage, onCheckCli, onUpdateCli, onCheckClaude, onUpdateClaude }: Props) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cliBusy, setCliBusy] = useState(false);
  const [cliError, setCliError] = useState("");
  const [claudeBusy, setClaudeBusy] = useState(false);

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

  const saveToken = () => run(async () => {
    await onSaveToken(token);
    setToken("");
  });

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
        <span className={status.tokenConfigured ? "ready" : ""}><KeyRound size={12} />{status.tokenConfigured ? "GitHub 已授权" : "GitHub 未授权"}</span>
        <button className="bare-button" onClick={() => void run(onOpenTokenPage)} title="打开 GitHub 创建授权码" aria-label="打开 GitHub 创建授权码"><ExternalLink size={12} /></button>
        {status.tokenConfigured ? <button className="bare-button danger-button" onClick={() => void run(onClearToken)} disabled={busy} title="移除 GitHub 授权" aria-label="移除 GitHub 授权"><Trash2 size={12} /></button> : null}
      </div>
      {!status.tokenConfigured ? <div className="update-token-row">
        <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="粘贴 GitHub 授权码" autoComplete="off" />
        <button onClick={() => void saveToken()} disabled={busy || token.trim().length < 20}>保存</button>
      </div> : null}
      <div className={`update-status ${status.phase}`}>{error || status.message}</div>
      {status.phase === "available" ? <button className="update-action" onClick={() => void run(onDownload)} disabled={busy}><Download size={13} />下载 v{status.availableVersion}</button>
        : status.phase === "downloaded" ? <button className="update-action primary" onClick={install} disabled={busy}><RefreshCw size={13} />重启安装</button>
          : <button className="update-action" onClick={() => void run(onCheck)} disabled={busy || checking || downloading || unsupported}><RefreshCw className={checking ? "spin" : ""} size={13} />{downloading ? `下载中 ${status.progress || 0}%` : checking ? "检查中" : unsupported ? "仅安装版可用" : "检查更新"}</button>}
    </section>
  </div>;
}

export default memo(UpdateSettingsBase);
