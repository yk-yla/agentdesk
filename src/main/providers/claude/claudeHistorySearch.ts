export interface ClaudeSearchSession {
  sessionId: string;
  customTitle?: string;
  summary?: string;
  firstPrompt?: string;
}

type MessageLoader = (sessionId: string, options: { dir?: string; limit: number; offset: number }) => Promise<unknown>;

export const DEFAULT_CLAUDE_SEARCH_CONCURRENCY = 4;

export function visibleSessionText(value: unknown, budget = 64 * 1024) {
  const parts: string[] = [];
  let length = 0;
  const visit = (item: unknown, depth: number) => {
    if (length >= budget || depth > 8 || item === null || item === undefined) return;
    if (typeof item === "string") {
      if (item.trim()) {
        const text = item.slice(0, budget - length);
        parts.push(text);
        length += text.length + 1;
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    for (const key of ["text", "content", "message", "prompt", "summary", "customTitle", "firstPrompt"]) {
      if (key in record) visit(record[key], depth + 1);
    }
  };
  visit(value, 0);
  return parts.join("\n").slice(0, budget);
}

export function searchSnippet(text: string, needle: string) {
  const index = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (index < 0) return text.slice(0, 800);
  const start = Math.max(0, index - 240);
  return text.slice(start, start + 800);
}

export async function sessionSearchText(session: ClaudeSearchSession, cwd: string | undefined, loadMessages: MessageLoader) {
  let text = [session.customTitle, session.summary, session.firstPrompt].filter(Boolean).join("\n");
  for (let offset = 0; offset < 1_000; offset += 200) {
    const messages = await loadMessages(session.sessionId, { ...(cwd ? { dir: cwd } : {}), limit: 200, offset });
    text = `${text}\n${visibleSessionText(messages)}`.slice(0, 512 * 1024);
    if (!Array.isArray(messages) || messages.length < 200) break;
  }
  return text;
}

export async function searchClaudeHistorySessions<T extends ClaudeSearchSession>(
  sessions: T[],
  cwd: string | undefined,
  searchTerm: string,
  limit: number,
  loadMessages: MessageLoader,
  concurrency = DEFAULT_CLAUDE_SEARCH_CONCURRENCY,
) {
  const needle = searchTerm.toLocaleLowerCase();
  const matches: Array<{ index: number; session: T; snippet: string }> = [];
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency) || DEFAULT_CLAUDE_SEARCH_CONCURRENCY, sessions.length || 1));
  let nextIndex = 0;
  let matchedCount = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= sessions.length || matchedCount >= limit) return;
      const session = sessions[index];
      try {
        const text = await sessionSearchText(session, cwd, loadMessages);
        if (!text.toLocaleLowerCase().includes(needle)) continue;
        matchedCount += 1;
        matches.push({ index, session, snippet: searchSnippet(text, searchTerm) });
      } catch {
        // A corrupt transcript should not abort search across other sessions.
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return matches
    .sort((left, right) => left.index - right.index)
    .slice(0, limit)
    .map(({ session, snippet }) => ({ session, snippet }));
}
