import { Settings2 } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { MAX_BASE_FONT_SIZE, MIN_BASE_FONT_SIZE, type BossKeyStatus, type ClaudeRuntimeStatus, type CodexCliUpdateStatus, type DesktopPreferences, type DesktopUpdateStatus, type DisplayMode, type ThemeId } from "../shared/protocol";

const SettingsAdvanced = lazy(() => import("./SettingsAdvanced"));

const THEME_OPTIONS: Array<{ id: ThemeId; label: string; swatch: string }> = [
  { id: "github-light", label: "GitHub Light", swatch: "#e8f4ee" },
  { id: "modern-dark", label: "Modern Dark", swatch: "#1f1f1f" },
  { id: "github-dark-dimmed", label: "GitHub Dark Dimmed", swatch: "#22272e" },
];

const DISPLAY_OPTIONS: Array<{ id: DisplayMode; label: string; hint: string }> = [
  { id: "simple", label: "简洁", hint: "只看对话与关键异常" },
  { id: "full", label: "完整", hint: "显示全部活动；原始事件在详情中查看" },
];

export interface SettingsPopoverViewModel {
  theme: ThemeId;
  baseFontSize: number;
  displayMode: DisplayMode;
  updateStatus: DesktopUpdateStatus;
  cliUpdateStatus: CodexCliUpdateStatus;
  claudeStatus: ClaudeRuntimeStatus;
  bossKeyStatus: BossKeyStatus;
  activeClaudeWorkspace: string;
}

export interface SettingsPopoverActions {
  onSavePreference: (patch: Partial<DesktopPreferences>) => void;
  onSetBossKey: (accelerator: string) => Promise<BossKeyStatus>;
  onSaveUpdateToken: (token: string) => Promise<void>;
  onClearUpdateToken: () => Promise<void>;
  onCheckForUpdates: () => Promise<void>;
  onCheckCodexCliUpdates: () => Promise<void>;
  onUpdateCodexCli: () => Promise<void>;
  onCheckClaude: () => Promise<void>;
  onUpdateClaude: () => Promise<void>;
  onRevokeClaudeWorkspace: (cwd: string) => Promise<void>;
  onDownloadUpdate: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
  onOpenUpdateTokenPage: () => Promise<void>;
}

export interface SettingsPopoverConfig {
  viewModel: SettingsPopoverViewModel;
  actions: SettingsPopoverActions;
}

interface Props extends SettingsPopoverConfig {
  collapsed: boolean;
}

export default function SettingsPopover({ collapsed, viewModel, actions }: Props) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const cliUpdateAvailable = viewModel.cliUpdateStatus.phase === "available";

  useEffect(() => { if (collapsed) setOpen(false); }, [collapsed]);
  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", closeOnOutsideMouseDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideMouseDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <>
    <button ref={buttonRef} className="icon-button settings-button" onClick={() => setOpen((value) => !value)} title={cliUpdateAvailable ? "设置，有 Codex CLI 新版本" : "设置"} aria-label={cliUpdateAvailable ? "设置，有 Codex CLI 新版本" : "设置"} aria-expanded={open}><Settings2 size={16} />{cliUpdateAvailable && !open ? <span className="settings-update-badge" aria-hidden="true" /> : null}</button>
    {open ? <div ref={popoverRef} className="settings-popover">
      <div className="settings-title">设置</div>
      <label>主题<div className="settings-select-row"><span className="theme-swatch" style={{ background: THEME_OPTIONS.find((option) => option.id === viewModel.theme)?.swatch || "#7d8794" }} /><select value={viewModel.theme} onChange={(event) => actions.onSavePreference({ theme: event.target.value as ThemeId })}>{THEME_OPTIONS.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></div></label>
      <label><span className="font-size-label"><span>基础字号</span><output>{viewModel.baseFontSize}px</output></span><input className="font-size-slider" type="range" min={MIN_BASE_FONT_SIZE} max={MAX_BASE_FONT_SIZE} step={1} value={viewModel.baseFontSize} aria-label="基础字号" onChange={(event) => actions.onSavePreference({ baseFontSize: Number(event.target.value) })} /></label>
      <label>消息详细程度<select value={viewModel.displayMode} onChange={(event) => actions.onSavePreference({ displayMode: event.target.value as DisplayMode })}>{DISPLAY_OPTIONS.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
      <div className="settings-hint">{DISPLAY_OPTIONS.find((option) => option.id === viewModel.displayMode)?.hint}</div>
      <Suspense fallback={<div className="settings-lazy-loading" aria-busy="true">正在加载高级设置</div>}>
        <SettingsAdvanced bossKey={{ status: viewModel.bossKeyStatus, onChange: actions.onSetBossKey }} update={{ status: viewModel.updateStatus, cliStatus: viewModel.cliUpdateStatus, claudeStatus: viewModel.claudeStatus, onSaveToken: actions.onSaveUpdateToken, onClearToken: actions.onClearUpdateToken, onCheck: actions.onCheckForUpdates, onCheckCli: actions.onCheckCodexCliUpdates, onUpdateCli: actions.onUpdateCodexCli, onCheckClaude: actions.onCheckClaude, onUpdateClaude: actions.onUpdateClaude, onRevokeClaudeWorkspace: actions.onRevokeClaudeWorkspace, activeClaudeWorkspace: viewModel.activeClaudeWorkspace, onDownload: actions.onDownloadUpdate, onInstall: actions.onInstallUpdate, onOpenTokenPage: actions.onOpenUpdateTokenPage }} />
      </Suspense>
    </div> : null}
  </>;
}
