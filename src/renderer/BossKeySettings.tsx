import { Keyboard } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { captureBossKey, displayBossKey } from "../shared/bossKey";
import type { BossKeyStatus } from "../shared/protocol";

interface Props {
  status: BossKeyStatus;
  onChange: (accelerator: string) => Promise<BossKeyStatus>;
}

export default function BossKeySettings({ status, onChange }: Props) {
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const captureRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (capturing) captureRef.current?.focus();
  }, [capturing]);

  const handleKeyDown = async (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!capturing || saving) return;
    event.preventDefault();
    event.stopPropagation();
    const result = captureBossKey(event);
    if (result.canceled) {
      setCapturing(false);
      setMessage("");
      setMessageIsError(false);
      return;
    }
    if (result.error) {
      setMessage(result.error);
      setMessageIsError(true);
      return;
    }
    if (!result.accelerator) return;

    setCapturing(false);
    setSaving(true);
    setMessage("");
    setMessageIsError(false);
    try {
      const next = await onChange(result.accelerator);
      setMessage(next.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "老板键设置失败。");
      setMessageIsError(true);
    } finally {
      setSaving(false);
    }
  };

  return <div className="boss-key-settings">
    <div className="settings-section-title">老板键</div>
    <div className="boss-key-row">
      <kbd className={`boss-key-value ${capturing ? "capturing" : ""}`}>{capturing ? "请按快捷键" : displayBossKey(status.accelerator)}</kbd>
      <button
        ref={captureRef}
        type="button"
        className="boss-key-capture"
        disabled={saving}
        onClick={() => { setMessage(""); setMessageIsError(false); setCapturing(true); }}
        onKeyDown={(event) => void handleKeyDown(event)}
        title="修改老板键"
      ><Keyboard size={14} /><span>{saving ? "保存中" : capturing ? "录入中" : "修改"}</span></button>
    </div>
    <div className={`boss-key-status ${!status.registered || messageIsError ? "error" : ""}`}>
      {message || (status.registered ? "已启用" : status.message)}
    </div>
  </div>;
}
