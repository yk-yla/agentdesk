interface ThreadWorkspace {
  cwd?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cwdFromThread(value: unknown) {
  const cwd = (record(value) as ThreadWorkspace).cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd : "";
}

export function trustedThreadWorkspaces(method: string, payload: unknown): string[] {
  const envelope = record(payload);
  if (method === "thread/list") {
    const data = Array.isArray(envelope.data) ? envelope.data : [];
    return data.map(cwdFromThread).filter(Boolean);
  }
  if (method === "thread/search") {
    const data = Array.isArray(envelope.data) ? envelope.data : [];
    return data.map((entry) => cwdFromThread(record(entry).thread)).filter(Boolean);
  }
  if (["thread/read", "thread/start", "thread/fork", "thread/resume"].includes(method)) {
    const cwd = cwdFromThread(envelope.thread);
    return cwd ? [cwd] : [];
  }
  if (method === "thread/started") {
    const cwd = cwdFromThread(envelope.thread);
    return cwd ? [cwd] : [];
  }
  return [];
}
