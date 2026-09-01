export type LocalLinkKind = "local" | "external" | "anchor" | "unsupported";

export interface LocalFileLink {
  kind: LocalLinkKind;
  value: string;
}

function decode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fileUrlToPath(value: string) {
  const withoutScheme = decode(value.replace(/^file:\/\//i, ""));
  if (/^\/[a-z]:[\\/]/i.test(withoutScheme)) return withoutScheme.slice(1);
  if (!withoutScheme.startsWith("/")) return `\\\\${withoutScheme}`;
  return withoutScheme;
}

function isWindowsAbsolute(value: string) {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

function normalizeWindowsDrivePath(value: string) {
  return value.replace(/^\/(?=[a-z]:[\\/])/i, "");
}

export function classifyLocalLink(href: string, cwd: string): LocalFileLink {
  const value = href.trim();
  if (!value) return { kind: "unsupported", value };
  if (value.startsWith("#")) return { kind: "anchor", value };
  if (/^https?:\/\//i.test(value)) return { kind: "external", value };
  const decoded = normalizeWindowsDrivePath(/^file:\/\//i.test(value) ? fileUrlToPath(value) : decode(value));
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded) && !isWindowsAbsolute(decoded)) return { kind: "unsupported", value: decoded };
  if (isWindowsAbsolute(decoded) || decoded.startsWith("/")) return { kind: "local", value: decoded };
  const base = cwd.replace(/[\\/]$/, "");
  return { kind: "local", value: base ? `${base}\\${decoded.replace(/^[/\\]+/, "")}` : decoded };
}
