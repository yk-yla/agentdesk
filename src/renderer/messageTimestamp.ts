function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

export function formatMessageTimestamp(timestamp: number, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const value = new Date(timestamp);
  const today = new Date(now);
  const time = `${twoDigits(value.getHours())}:${twoDigits(value.getMinutes())}:${twoDigits(value.getSeconds())}`;
  if (value.getFullYear() === today.getFullYear()
    && value.getMonth() === today.getMonth()
    && value.getDate() === today.getDate()) return time;
  return `${value.getFullYear()}-${twoDigits(value.getMonth() + 1)}-${twoDigits(value.getDate())} ${time}`;
}

export function timestampFromUnknown(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
