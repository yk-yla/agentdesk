const SECRET_KEY = /(token|secret|password|authorization|api[_-]?key|private[_-]?key|cookie|credential)/i;
const MAX_STRING = 8 * 1024;
const MAX_DEPTH = 8;
const MAX_KEYS = 256;

export function redactClaudeValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[截断]";
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[已截断]` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, MAX_KEYS).map((item) => redactClaudeValue(item, depth + 1));
  if (!value || typeof value !== "object") return String(value);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
    result[key] = SECRET_KEY.test(key) ? "[已脱敏]" : redactClaudeValue(item, depth + 1);
  }
  return result;
}

export function redactClaudeMessage(message: unknown) {
  return redactClaudeValue(message);
}

