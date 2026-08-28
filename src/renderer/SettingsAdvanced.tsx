import { Check, Save, X } from "lucide-react";
import { useEffect, useState, type ComponentProps } from "react";
import UpdateSettings from "./UpdateSettings";
import type { DesktopPreferences } from "../shared/protocol";
import { EXTERNAL_TERMINAL_PRESETS, externalTerminalKindForSettings, externalTerminalLabel, externalTerminalSettingsForPreset, type ExternalTerminalKind } from "../shared/externalTerminalPresets";
import { userFacingErrorMessage } from "./errorMessage";

interface Props {
  update: ComponentProps<typeof UpdateSettings>;
  externalTerminal: { value: NonNullable<DesktopPreferences["externalTerminal"]>; onSave: (patch: Partial<DesktopPreferences>) => Promise<void> };
}

export default function SettingsAdvanced({ update, externalTerminal: externalTerminalConfig }: Props) {
  const [kind, setKind] = useState<ExternalTerminalKind>(() => externalTerminalKindForSettings(externalTerminalConfig.value));
  const [executable, setExecutable] = useState(externalTerminalConfig.value.executable);
  const [argsTemplate, setArgsTemplate] = useState(externalTerminalConfig.value.argsTemplate);
  const [saving, setSaving] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [successText, setSuccessText] = useState("");
  useEffect(() => {
    setKind(externalTerminalKindForSettings(externalTerminalConfig.value));
    setExecutable(externalTerminalConfig.value.executable);
    setArgsTemplate(externalTerminalConfig.value.argsTemplate);
    setSaving(false);
  }, [externalTerminalConfig.value.argsTemplate, externalTerminalConfig.value.executable, externalTerminalConfig.value.kind]);

  const selectTerminal = (nextKind: ExternalTerminalKind) => {
    setKind(nextKind);
    setErrorText("");
    setSuccessText("");
    if (nextKind === "custom") return;
    const settings = externalTerminalSettingsForPreset(nextKind);
    setExecutable(settings.executable);
    setArgsTemplate(settings.argsTemplate);
  };

  const saveTerminal = async () => {
    if (saving) return;
    setSaving(true);
    setErrorText("");
    setSuccessText("");
    const nextSettings = kind === "custom"
      ? { kind, executable: executable.trim(), argsTemplate }
      : externalTerminalSettingsForPreset(kind);
    try {
      await externalTerminalConfig.onSave({ externalTerminal: nextSettings });
      setSuccessText(`${externalTerminalLabel(nextSettings)} 已保存，可以使用。`);
    } catch (error) {
      setErrorText(userFacingErrorMessage(error, "保存终端设置失败。"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section className="settings-terminal-config">
        <div className="settings-section-title">外部终端</div>
        <label className="settings-field">终端程序<select value={kind} disabled={saving} onChange={(event) => selectTerminal(event.target.value as ExternalTerminalKind)}>{EXTERNAL_TERMINAL_PRESETS.map((preset) => <option value={preset.id} key={preset.id}>{preset.label}</option>)}<option value="custom">自定义终端</option></select></label>
        {kind === "custom" ? <><label className="settings-field">程序路径<input value={executable} disabled={saving} onChange={(event) => { setExecutable(event.target.value); setErrorText(""); setSuccessText(""); }} placeholder="终端程序路径或命令" /></label><label className="settings-field">参数模板<textarea value={argsTemplate} disabled={saving} onChange={(event) => { setArgsTemplate(event.target.value); setErrorText(""); setSuccessText(""); }} rows={3} placeholder={'-NoExit -Command "claude --session-id {sessionId}"'} /></label></> : null}
        <div className="settings-terminal-actions"><button type="button" className="settings-terminal-save" disabled={saving} onClick={() => void saveTerminal()}><Save size={14} />{saving ? "正在检测" : "保存"}</button></div>
        {errorText ? <div className="settings-terminal-error" role="alert"><span>{errorText}</span><button type="button" className="bare-button" onClick={() => setErrorText("")} title="关闭" aria-label="关闭错误提示"><X size={14} /></button></div> : null}
        {successText ? <div className="settings-terminal-success" role="status"><Check size={14} /><span>{successText}</span><button type="button" className="bare-button" onClick={() => setSuccessText("")} title="关闭" aria-label="关闭保存提示"><X size={14} /></button></div> : null}
      </section>
      <UpdateSettings {...update} />
    </>
  );
}
