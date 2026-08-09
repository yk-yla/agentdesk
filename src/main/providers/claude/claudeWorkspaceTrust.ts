import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

const trusted = new Set<string>();

export function canonicalWorkspace(value: string) {
  const resolved = path.resolve(value);
  try { return realpathSync(resolved); } catch { return resolved; }
}

export function isTrustedWorkspace(value: string) {
  const resolved = canonicalWorkspace(value);
  return trusted.has(resolved);
}

export function trustWorkspace(value: string) {
  const resolved = canonicalWorkspace(value);
  if (!existsSync(resolved)) throw new Error("Claude 工作区不存在。");
  trusted.add(resolved);
  return resolved;
}

export function revokeWorkspace(value: string) {
  trusted.delete(canonicalWorkspace(value));
}

export function trustedWorkspaces() {
  return [...trusted];
}

export function replaceTrustedWorkspaces(values: string[]) {
  trusted.clear();
  for (const value of values) {
    try {
      const resolved = canonicalWorkspace(value);
      if (existsSync(resolved)) trusted.add(resolved);
    } catch {
      // Invalid or removed workspaces are not trusted.
    }
  }
  return trustedWorkspaces();
}
