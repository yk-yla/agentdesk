const SECRET_KEY = /(secret|password|authorization|api[_-]?key|private[_-]?key|cookie|credential)/i;
const SECRET_TOKEN_KEY = /(?:auth|access|refresh|session|bearer|oauth|api)[_-]?token$/i;
const MAX_STRING = 8 * 1024;
const MAX_DEPTH = 8;
const MAX_KEYS = 256;

function isSecretKey(key: string) {
  return SECRET_KEY.test(key) || key === "token" || SECRET_TOKEN_KEY.test(key);
}

function redactClaudeValueInner(value: unknown, depth: number, preserveLongString: boolean): unknown {
  if (depth > MAX_DEPTH) return "[截断]";
  if (typeof value === "string") return !preserveLongString && value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[已截断]` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, MAX_KEYS).map((item) => redactClaudeValueInner(item, depth + 1, false));
  if (!value || typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  const isTextBlock = record.type === "text";
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record).slice(0, MAX_KEYS)) {
    result[key] = isSecretKey(key)
      ? "[已脱敏]"
      : redactClaudeValueInner(item, depth + 1, isTextBlock && key === "text");
  }
  return result;
}

export function redactClaudeValue(value: unknown, depth = 0): unknown {
  return redactClaudeValueInner(value, depth, false);
}

export function redactClaudeMessage(message: unknown) {
  return redactClaudeValue(message);
}

