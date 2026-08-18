import type { AgentOperation } from "../shared/agentProtocol";
import type { JsonObject } from "../shared/protocol";
import { stringValue, type Message, type SessionState } from "./domain";

const MAX_TITLE_CONTEXT_MESSAGES = 24;
const MAX_TITLE_CONTEXT_CHARS = 12_000;
const MAX_TITLE_MESSAGE_CHARS = 3_000;

export interface SessionTitleState {
  getSession(sessionId: string): SessionState | undefined;
}

export interface SessionTitleServices {
  request(sessionId: string, operation: AgentOperation, params: JsonObject): Promise<unknown>;
  applyTitle(sessionId: string, title: string, source: "native" | "generated"): void;
  log?(level: "debug" | "warn", event: string, details?: JsonObject): void;
}

function roleLabel(message: Message) {
  return message.role === "assistant" ? "助手" : "用户";
}

export function titleConversation(messages: Message[]) {
  const entries = messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.text.trim())
    .slice(-MAX_TITLE_CONTEXT_MESSAGES)
    .map((message) => `${roleLabel(message)}：${message.text.slice(0, MAX_TITLE_MESSAGE_CHARS)}`);
  let result = "";
  for (const entry of entries) {
    const next = result ? `${result}\n${entry}` : entry;
    if (next.length > MAX_TITLE_CONTEXT_CHARS) break;
    result = next;
  }
  return result;
}

function generatedTitle(value: unknown) {
  const title = stringValue(value).replace(/\s+/g, " ").replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
  return title.slice(0, 80);
}

function resultTitle(value: unknown) {
  const result = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { title: generatedTitle(result.title), source: result.source === "native" ? "native" as const : "generated" as const };
}

export class SessionTitleController {
  private readonly generations = new Map<string, number>();
  private readonly attempted = new Map<string, Set<string>>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly state: SessionTitleState,
    private readonly services: SessionTitleServices,
  ) {}

  invalidate(sessionId: string) {
    this.generations.set(sessionId, (this.generations.get(sessionId) || 0) + 1);
  }

  reset(sessionId: string) {
    this.invalidate(sessionId);
    this.attempted.delete(sessionId);
  }

  release(sessionId: string) {
    this.reset(sessionId);
  }

  readonly refreshAfterTurn = (sessionId: string, turnStatus: string) => {
    if (turnStatus === "interrupted" || turnStatus === "failed") return;
    const session = this.state.getSession(sessionId);
    if (!session?.threadId || session.titleOrigin !== "fallback") return;
    if (this.inFlight.has(sessionId)) return;
    const key = `${session.provider}:${session.threadId}`;
    const previous = this.attempted.get(sessionId) || new Set<string>();
    if (previous.has(key)) return;
    previous.add(key);
    this.attempted.set(sessionId, previous);
    const generation = this.generations.get(sessionId) || 0;
    const baselineTitle = session.title;
    const conversation = titleConversation(session.messages);
    if (!conversation) return;

    const task = this.resolve(sessionId, session, generation, baselineTitle, conversation);
    this.inFlight.set(sessionId, task);
    void task.finally(() => {
      if (this.inFlight.get(sessionId) === task) this.inFlight.delete(sessionId);
    });
  };

  private async resolve(sessionId: string, session: SessionState, generation: number, baselineTitle: string, conversation: string) {
    try {
      const response = await this.services.request(sessionId, "generateSessionTitle", {
        threadId: session.threadId as string,
        cwd: session.cwd,
        conversation,
      });
      const current = this.state.getSession(sessionId);
      const { title, source } = resultTitle(response);
      if (!title || !current || current.threadId !== session.threadId || current.titleOrigin !== "fallback" || current.title !== baselineTitle || (this.generations.get(sessionId) || 0) !== generation) return;
      this.services.applyTitle(sessionId, title, source);
    } catch (error) {
      this.services.log?.("warn", "renderer.session_title.failed", {
        provider: session.provider,
        sessionId,
        error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
      });
    }
  }
}
