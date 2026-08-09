export const DEFAULT_BOSS_KEY = "F2";

const MODIFIER_ORDER = ["Control", "Alt", "Shift", "Super"] as const;
const MODIFIER_ALIASES: Record<string, typeof MODIFIER_ORDER[number]> = {
  control: "Control",
  ctrl: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  super: "Super",
  meta: "Super",
  win: "Super",
  windows: "Super",
};
const NAMED_KEYS: Record<string, string> = {
  " ": "Space",
  space: "Space",
  spacebar: "Space",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

export interface BossKeyKeyboardInput {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
}

export interface BossKeyCaptureResult {
  accelerator?: string;
  canceled?: boolean;
  error?: string;
}

function normalizeMainKey(value: string) {
  const key = value.trim();
  if (!key && value !== " ") return null;
  const named = NAMED_KEYS[value.toLowerCase()] || NAMED_KEYS[key.toLowerCase()];
  if (named) return named;
  if (/^f(?:[1-9]|1\d|2[0-4])$/i.test(key)) return key.toUpperCase();
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  return null;
}

export function normalizeBossKeyAccelerator(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 80) return null;
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const mainKey = normalizeMainKey(parts.at(-1) || "");
  if (!mainKey || mainKey === "F12") return null;

  const modifiers = new Set<typeof MODIFIER_ORDER[number]>();
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (!modifier || modifiers.has(modifier)) return null;
    modifiers.add(modifier);
  }
  if (!modifiers.size && !/^F(?:[1-9]|1\d|2[0-4])$/.test(mainKey)) return null;
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), mainKey].join("+");
}

export function captureBossKey(input: BossKeyKeyboardInput): BossKeyCaptureResult {
  if (input.repeat) return {};
  if (input.key === "Escape") return { canceled: true };
  if (["Control", "Alt", "Shift", "Meta"].includes(input.key)) return {};

  const mainKey = normalizeMainKey(input.key);
  if (!mainKey) return { error: "不支持这个按键，请使用功能键、字母、数字或常用控制键。" };
  if (mainKey === "F12") return { error: "F12 由 Windows 调试功能保留，请换一个按键。" };

  const modifiers = [
    input.ctrlKey ? "Control" : "",
    input.altKey ? "Alt" : "",
    input.shiftKey ? "Shift" : "",
    input.metaKey ? "Super" : "",
  ].filter(Boolean);
  const accelerator = [...modifiers, mainKey].join("+");
  const normalized = normalizeBossKeyAccelerator(accelerator);
  return normalized
    ? { accelerator: normalized }
    : { error: "普通按键必须搭配 Ctrl、Alt、Shift 或 Win。" };
}

export function displayBossKey(accelerator: string) {
  return accelerator.replaceAll("Control", "Ctrl").replaceAll("Super", "Win");
}
