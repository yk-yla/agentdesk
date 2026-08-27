function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

const MESSAGE_TIME_GAP_MS = 10 * 60 * 1000;

function isValidTimestamp(timestamp: number | undefined): timestamp is number {
  return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0;
}

function isSameLocalDate(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function formatTime(value: Date, includeSeconds: boolean) {
  const base = `${twoDigits(value.getHours())}:${twoDigits(value.getMinutes())}`;
  return includeSeconds ? `${base}:${twoDigits(value.getSeconds())}` : base;
}

export function formatMessageTimestamp(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const value = new Date(timestamp);
  return formatTime(value, true);
}

/** 详情面板事件时间：今天只显示时分秒，其他日期显示日期和时分秒。 */
export function formatEventTimestamp(timestamp: number | undefined, now = Date.now()) {
  if (!isValidTimestamp(timestamp)) return "";
  const value = new Date(timestamp);
  const today = new Date(now);
  const time = formatTime(value, true);
  return isSameLocalDate(value, today)
    ? time
    : `${value.getFullYear()}-${twoDigits(value.getMonth() + 1)}-${twoDigits(value.getDate())} ${time}`;
}

export type MessageTimeDivider = { kind: "date" | "time"; label: string };

export function getMessageTimeDivider(timestamp: number | undefined, previousTimestamp: number | undefined, now = Date.now()): MessageTimeDivider | null {
  if (!isValidTimestamp(timestamp)) return null;
  const value = new Date(timestamp);
  const previous = isValidTimestamp(previousTimestamp) ? new Date(previousTimestamp) : null;
  if (!previous || !isSameLocalDate(value, previous)) {
    const today = new Date(now);
    if (isSameLocalDate(value, today)) return { kind: "date", label: "今天" };
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (isSameLocalDate(value, yesterday)) return { kind: "date", label: "昨天" };
    return { kind: "date", label: `${value.getFullYear()}年${value.getMonth() + 1}月${value.getDate()}日` };
  }
  if (timestamp - previous.getTime() > MESSAGE_TIME_GAP_MS) {
    return { kind: "time", label: formatTime(value, false) };
  }
  return null;
}

export function timestampFromUnknown(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
