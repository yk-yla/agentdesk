import { Settings2, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { type ClaudeRuntimeStatus, type CodexCliUpdateStatus, type DesktopPreferences, type DesktopUpdateStatus, type ThemeId, type DiagnosticExport } from "../shared/protocol";
import { DEFAULT_EXTERNAL_TERMINAL_KIND, externalTerminalSettingsForPreset } from "../shared/externalTerminalPresets";
import { trackUiEvent } from "./rendererDiagnostics";

const SettingsAdvanced = lazy(() => import("./SettingsAdvanced"));

const THEME_OPTIONS: Array<{ id: ThemeId; label: string; swatch: string }> = [
  { id: "github-light", label: "GitHub Light", swatch: "#e8f4ee" },
  { id: "modern-dark", label: "Modern Dark", swatch: "#1f1f1f" },
  { id: "github-dark-dimmed", label: "GitHub Dark Dimmed", swatch: "#22272e" },
];

export interface SettingsPopoverViewModel {
  theme: ThemeId;
  externalTerminal?: DesktopPreferences["externalTerminal"];
  updateStatus: DesktopUpdateStatus;
  cliUpdateStatus: CodexCliUpdateStatus;
  claudeStatus: ClaudeRuntimeStatus;
}

export interface SettingsPopoverActions {
  onSavePreference: (patch: Partial<DesktopPreferences>) => Promise<void>;
  onCheckForUpdates: () => Promise<void>;
  onCheckCodexCliUpdates: () => Promise<void>;
  onUpdateCodexCli: () => Promise<void>;
  onCheckClaude: () => Promise<void>;
  onUpdateClaude: () => Promise<void>;
  onDownloadUpdate: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
  onOpenUpdateRepository: () => Promise<void>;
  onExportDiagnostics: () => Promise<DiagnosticExport | null>;
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
  const updateAvailable = viewModel.updateStatus.phase === "available" || viewModel.updateStatus.phase === "downloaded"
    || viewModel.cliUpdateStatus.phase === "available"
    || viewModel.claudeStatus.phase === "available";
  const settingsLabel = updateAvailable ? "设置，有可用更新" : "设置";

  const close = (reason: string) => {
    setOpen((value) => {
      if (value) trackUiEvent("settings.closed", { reason });
      return false;
    });
  };

  const savePreference = (patch: Partial<DesktopPreferences>, event?: string, details?: Record<string, unknown>) => {
    if (event) trackUiEvent(`${event}.requested`, details || {});
    void actions.onSavePreference(patch)
      .then(() => { if (event) trackUiEvent(`${event}.completed`, details || {}); })
      .catch(() => { if (event) trackUiEvent(`${event}.failed`, details || {}); });
  };

  useEffect(() => { if (collapsed) close("sidebar_collapsed"); }, [collapsed]);
  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      close("outside");
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") close("escape"); };
    window.addEventListener("mousedown", closeOnOutsideMouseDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideMouseDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <>
    <button ref={buttonRef} className="icon-button settings-button" onClick={() => setOpen((value) => { const next = !value; trackUiEvent(next ? "settings.opened" : "settings.closed", { reason: "button" }); return next; })} title={settingsLabel} aria-label={settingsLabel} aria-expanded={open}><Settings2 size={16} />{updateAvailable && !open ? <span className="settings-update-badge" aria-hidden="true" /> : null}</button>
    {open ? <div ref={popoverRef} className="settings-popover">
      <div className="settings-header">
        <div className="settings-title">设置</div>
        <button type="button" className="bare-button settings-close" onClick={() => close("close_button")} title="关闭设置" aria-label="关闭设置"><X size={15} /></button>
      </div>
      <div className="settings-body">
        <section className="settings-appearance">
          <div className="settings-section-title">外观</div>
          <label className="settings-inline-field"><span>主题</span><div className="settings-select-control"><span className="theme-swatch" style={{ background: THEME_OPTIONS.find((option) => option.id === viewModel.theme)?.swatch || "#7d8794" }} /><select value={viewModel.theme} onChange={(event) => { const theme = event.target.value as ThemeId; savePreference({ theme }, "settings.theme_changed", { theme }); }}>{THEME_OPTIONS.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></div></label>
        </section>
        <Suspense fallback={<div className="settings-lazy-loading" aria-busy="true">正在加载高级设置</div>}>
          <SettingsAdvanced externalTerminal={{ value: viewModel.externalTerminal || externalTerminalSettingsForPreset(DEFAULT_EXTERNAL_TERMINAL_KIND), onSave: actions.onSavePreference }} update={{ status: viewModel.updateStatus, cliStatus: viewModel.cliUpdateStatus, claudeStatus: viewModel.claudeStatus, onCheck: actions.onCheckForUpdates, onCheckCli: actions.onCheckCodexCliUpdates, onUpdateCli: actions.onUpdateCodexCli, onCheckClaude: actions.onCheckClaude, onUpdateClaude: actions.onUpdateClaude, onDownload: actions.onDownloadUpdate, onInstall: actions.onInstallUpdate, onOpenRepository: actions.onOpenUpdateRepository, onExportDiagnostics: actions.onExportDiagnostics }} />
        </Suspense>
      </div>
    </div> : null}
  </>;
}
