import type { AgentOperation, AgentProvider } from "../shared/agentProtocol";
import type { JsonObject } from "../shared/protocol";
import { resolveComposerInput } from "./commandSuggestions";
import { asRecord, sessionTitle, stringValue, type ImageAttachment, type PendingSteerMessage, type QueuedMessage, type SessionState, type SkillOption } from "./domain";
import {
  actualTurnIdFromInterruptMismatch,
  actualTurnIdFromMismatch,
  codexRequestMethod,
  inputForMessage,
  insertRejectedSteer,
  isCodexRequestTimeout,
  isMissingActiveTurn,
  isNonSteerableTurn,
  mergeMessages,
} from "./inputQueue";

type ListUpdater<T> = T[] | ((current: T[]) => T[]);

export interface SessionMessageState {
  getSession(sessionId: string): SessionState | undefined;
  getQueued(sessionId: string): QueuedMessage[];
  getPendingSteers(sessionId: string): PendingSteerMessage[];
  getAttachments(sessionId: string): ImageAttachment[];
  getSkills(provider: AgentProvider, cwd: string): SkillOption[];
  updateSession(sessionId: string, updater: (current: SessionState) => SessionState): void;
  replaceQueued(sessionId: string, next: ListUpdater<QueuedMessage>): void;
  replacePendingSteers(sessionId: string, next: ListUpdater<PendingSteerMessage>): void;
  replaceAttachments(sessionId: string, next: ListUpdater<ImageAttachment>): void;
}

export interface SessionMessageServices {
  request(sessionId: string, operation: AgentOperation, params: JsonObject): Promise<unknown>;
  ensureThread(sessionId: string): Promise<string>;
  clearSession(sessionId: string): void;
  restoreMessagesToDraft(sessionId: string, messages: QueuedMessage[]): void;
  showStatus(sessionId: string): Promise<void>;
  showMcpStatus(sessionId: string): Promise<void>;
  upsertHistory(entry: { id: string; provider: AgentProvider; title: string; cwd: string }): void;
  now?: () => number;
}

export interface SessionMessageControllerOptions {
  state: SessionMessageState;
  services: SessionMessageServices;
}

export class SessionMessageController {
  private readonly queueDraining = new Map<string, Promise<void>>();
  private readonly steerChains = new Map<string, Promise<void>>();
  private readonly submitPendingAfterInterrupt = new Set<string>();
  private inputSequence = 0;

  constructor(private readonly options: SessionMessageControllerOptions) {}

  private now() {
    return this.options.services.now?.() ?? Date.now();
  }

  private nextInputId(prefix: string) {
    this.inputSequence += 1;
    return `${prefix}-${this.now()}-${this.inputSequence}`;
  }

  private setError(sessionId: string, error: unknown, fallback: string) {
    this.options.state.updateSession(sessionId, (current) => ({
      ...current,
      errorText: error instanceof Error ? error.message : fallback,
    }));
  }

  private rememberHistory(session: SessionState, threadId: string, title = session.title) {
    if (!threadId) return;
    this.options.services.upsertHistory({ id: threadId, provider: session.provider, title, cwd: session.cwd });
  }

  readonly createQueuedMessage = (text: string, prefix = "input"): QueuedMessage => {
    const id = this.nextInputId(prefix);
    return {
      id,
      clientUserMessageId: `client-${id}`,
      text,
      images: [],
      queueKind: "explicit",
      sequence: this.inputSequence,
    };
  };

  readonly runMessage = async (sessionId: string, message: QueuedMessage) => {
    const { state, services } = this.options;
    const session = state.getSession(sessionId);
    if (!session) return false;
    const clientUserMessageId = message.clientUserMessageId || `client-${this.nextInputId("message")}`;
    const localCommand = message.text.trim();
    const requiredCapability = localCommand === "/compact" ? "compact" : localCommand === "/review" ? "review" : localCommand === "/mcp" ? "mcp" : null;
    if (requiredCapability && session.capabilities[requiredCapability] !== "supported") {
      state.updateSession(sessionId, (current) => ({
        ...current,
        errorText: session.capabilities[requiredCapability] === "temporarilyUnavailable" ? "该能力当前暂不可用。" : "当前 Provider 不支持该命令。",
      }));
      return false;
    }
    const isControlCommand = ["/compact", "/status", "/review", "/mcp"].includes(localCommand);
    const titleSource = message.skills?.length ? message.inputText || message.text : message.text;
    const nextTitle = session.title === "新会话" && !isControlCommand
      ? sessionTitle(titleSource, message.images[0]?.name || "图片会话")
      : session.title;
    state.updateSession(sessionId, (current) => ({
      ...current,
      errorText: "",
      title: nextTitle,
      updatedAt: this.now(),
      ...(localCommand === "/status" || localCommand === "/mcp"
        ? {}
        : { status: "working" as const, statusLabel: "正在提交", startedAt: this.now() }),
      messages: current.messages.some((entry) => entry.clientId === clientUserMessageId)
        ? current.messages
        : [...current.messages, { id: `user-${clientUserMessageId}`, clientId: clientUserMessageId, role: "user", text: message.text, images: message.images }],
    }));

    let threadId = "";
    try {
      if (localCommand === "/status") {
        await services.showStatus(sessionId);
        return true;
      }
      if (localCommand === "/mcp") {
        await services.showMcpStatus(sessionId);
        return true;
      }
      threadId = await services.ensureThread(sessionId);
      if (localCommand === "/compact") {
        await services.request(sessionId, "compactSession", { threadId });
        return true;
      }
      const requestMethod: AgentOperation = localCommand === "/review" ? "startReview" : "startTurn";
      const requestParams = localCommand === "/review"
        ? { threadId, target: { type: "uncommittedChanges" }, delivery: "inline" }
        : {
          threadId,
          cwd: session.cwd,
          input: inputForMessage(message),
          model: session.model || null,
          effort: session.effort || null,
          collaborationMode: {
            mode: session.collaborationMode,
            settings: { model: session.model, reasoning_effort: session.effort || null, developer_instructions: null },
          },
          clientUserMessageId,
        };
      const result = asRecord(await services.request(sessionId, requestMethod, requestParams));
      const turnId = stringValue(asRecord(result.turn).id);
      if (turnId) {
        state.updateSession(sessionId, (current) => ({
          ...current,
          activeTurnId: turnId,
          status: "working",
          statusLabel: localCommand === "/review" ? "正在审查" : "工作中",
        }));
      }
      this.rememberHistory(session, stringValue(result.reviewThreadId, threadId), nextTitle);
      return true;
    } catch (error) {
      const requestMethod = codexRequestMethod(error);
      if (isCodexRequestTimeout(error) && (requestMethod === "startTurn" || requestMethod === "startReview" || requestMethod === "compactSession")) {
        state.updateSession(sessionId, (current) => ({
          ...current,
          status: "working",
          statusLabel: "响应超时，后台状态待确认",
          errorText: "请求超时，任务可能仍在后台执行。",
        }));
        if (threadId) this.rememberHistory(session, threadId, nextTitle);
        return true;
      }
      state.updateSession(sessionId, (current) => ({
        ...current,
        status: "error",
        statusLabel: "提交失败",
        activeTurnId: null,
        startedAt: null,
        errorText: error instanceof Error ? error.message : "消息发送失败",
        messages: current.messages.filter((entry) => entry.clientId !== clientUserMessageId),
      }));
      return false;
    }
  };

  private async submitSteer(sessionId: string, steer: PendingSteerMessage) {
    const { state, services } = this.options;
    const removePending = () => {
      state.replacePendingSteers(sessionId, (current) => current.filter((entry) => entry.id !== steer.id));
    };
    const moveToRejectedQueue = () => {
      if (!state.getPendingSteers(sessionId).some((entry) => entry.id === steer.id)) return;
      removePending();
      state.replaceQueued(sessionId, insertRejectedSteer(state.getQueued(sessionId), steer));
    };

    const current = state.getSession(sessionId);
    if (!current?.threadId || current.status !== "working" || !current.activeTurnId) {
      removePending();
      if (current && current.status !== "working") {
        const accepted = await this.runMessage(sessionId, steer);
        if (!accepted) services.restoreMessagesToDraft(sessionId, [steer]);
      } else {
        state.replaceQueued(sessionId, [...state.getQueued(sessionId), { ...steer, queueKind: "explicit" }]);
      }
      return;
    }

    let expectedTurnId = current.activeTurnId || steer.expectedTurnId;
    for (const retried of [false, true]) {
      try {
        await services.request(sessionId, "steerTurn", {
          threadId: current.threadId,
          input: inputForMessage(steer),
          expectedTurnId,
          clientUserMessageId: steer.clientUserMessageId,
        });
        const latest = state.getSession(sessionId);
        if (latest?.threadId) {
          state.updateSession(sessionId, (session) => ({ ...session, updatedAt: this.now() }));
          this.rememberHistory(latest, latest.threadId);
        }
        return;
      } catch (error) {
        if (isCodexRequestTimeout(error)) {
          this.setError(sessionId, error, "追加请求超时，等待后台任务确认");
          return;
        }
        if (isNonSteerableTurn(error)) {
          moveToRejectedQueue();
          return;
        }
        if (isMissingActiveTurn(error)) {
          removePending();
          state.updateSession(sessionId, (session) => ({ ...session, activeTurnId: null, status: "idle", startedAt: null }));
          const accepted = await this.runMessage(sessionId, steer);
          if (!accepted) services.restoreMessagesToDraft(sessionId, [steer]);
          return;
        }
        const actualTurnId = actualTurnIdFromMismatch(error);
        if (!retried && actualTurnId && actualTurnId !== expectedTurnId) {
          expectedTurnId = actualTurnId;
          state.updateSession(sessionId, (session) => ({ ...session, activeTurnId: actualTurnId }));
          continue;
        }
        moveToRejectedQueue();
        this.setError(sessionId, error, "追加任务失败");
        return;
      }
    }
  }

  private enqueueSteer(sessionId: string, steer: PendingSteerMessage) {
    const previous = this.steerChains.get(sessionId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.submitSteer(sessionId, steer));
    this.steerChains.set(sessionId, next);
    void next.finally(() => {
      if (this.steerChains.get(sessionId) === next) this.steerChains.delete(sessionId);
    });
  }

  readonly sendMessage = (sessionId: string, text: string, mode: "submit" | "queue" = "submit") => {
    const { state, services } = this.options;
    const session = state.getSession(sessionId);
    if (!session) return;
    const sessionAttachments = state.getAttachments(sessionId);
    if (!text && !sessionAttachments.length) return;
    const availableSkills = session.capabilities.skills === "supported" ? state.getSkills(session.provider, session.cwd) : [];
    const resolved = resolveComposerInput(text, availableSkills, session.capabilities);
    const commandName = resolved.kind === "command" ? resolved.name : null;
    const skillInputText = resolved.kind === "skill"
      ? `${resolved.skill.path.startsWith("command:") ? "/" : "$"}${resolved.skill.name}${resolved.prompt ? ` ${resolved.prompt}` : ""}`
      : "";
    if (commandName === "clear") {
      services.clearSession(sessionId);
      return;
    }
    const id = this.nextInputId(mode === "queue" ? "queued" : "input");
    const message: QueuedMessage & { clientUserMessageId: string } = {
      id,
      clientUserMessageId: `client-${id}`,
      text: commandName ? `/${commandName}` : text,
      ...(skillInputText ? { inputText: skillInputText } : {}),
      images: commandName ? [] : sessionAttachments,
      queueKind: "explicit",
      sequence: this.inputSequence,
    };
    if (!commandName) state.replaceAttachments(sessionId, []);
    if (commandName === "status" || commandName === "mcp") {
      void this.runMessage(sessionId, message).then((accepted) => {
        if (!accepted) services.restoreMessagesToDraft(sessionId, [message]);
      });
      return;
    }
    if (session.status === "working" && (mode === "queue" || !session.threadId || !session.activeTurnId)) {
      state.replaceQueued(sessionId, [...state.getQueued(sessionId), message]);
      return;
    }
    if (session.status === "working" && (commandName || session.capabilities.steer !== "supported")) {
      state.replaceQueued(sessionId, [...state.getQueued(sessionId), message]);
      return;
    }
    if (session.status === "working" && session.threadId && session.activeTurnId && session.capabilities.steer === "supported") {
      const steer: PendingSteerMessage = { ...message, expectedTurnId: session.activeTurnId };
      state.replacePendingSteers(sessionId, [...state.getPendingSteers(sessionId), steer]);
      this.enqueueSteer(sessionId, steer);
      return;
    }
    void this.runMessage(sessionId, message).then((accepted) => {
      if (!accepted) services.restoreMessagesToDraft(sessionId, [message]);
    });
  };

  readonly removeQueuedMessage = (sessionId: string, queuedId: string) => {
    this.options.state.replaceQueued(sessionId, (current) => current.filter((entry) => entry.id !== queuedId));
  };

  readonly drainQueues = async (sessionIds: Iterable<string>) => {
    const drains: Promise<void>[] = [];
    for (const sessionId of sessionIds) {
      const session = this.options.state.getSession(sessionId);
      const queue = this.options.state.getQueued(sessionId);
      if (!session || session.status !== "idle" || !queue.length) continue;
      const active = this.queueDraining.get(sessionId);
      if (active) {
        drains.push(active);
        continue;
      }
      const rejected = queue.filter((entry) => entry.queueKind === "rejectedSteer");
      const batch = rejected.length ? rejected : [queue[0]];
      const next = rejected.length ? { ...mergeMessages(rejected), queueKind: "rejectedSteer" as const } : queue[0];
      const sentIds = new Set(batch.map((entry) => entry.id));
      const drain = this.runMessage(sessionId, next).then((accepted) => {
        if (accepted) this.options.state.replaceQueued(sessionId, (current) => current.filter((entry) => !sentIds.has(entry.id)));
      }).finally(() => {
        if (this.queueDraining.get(sessionId) === drain) this.queueDraining.delete(sessionId);
      });
      this.queueDraining.set(sessionId, drain);
      drains.push(drain);
    }
    await Promise.all(drains);
  };

  readonly interrupt = async (sessionId: string) => {
    const { state, services } = this.options;
    const session = state.getSession(sessionId);
    if (!session?.threadId || session.status !== "working") return false;
    if (state.getPendingSteers(sessionId).length) this.submitPendingAfterInterrupt.add(sessionId);
    let turnId = session.activeTurnId || "";
    try {
      for (const retried of [false, true]) {
        try {
          await services.request(sessionId, "interruptTurn", { threadId: session.threadId, turnId });
          return true;
        } catch (error) {
          const actualTurnId = actualTurnIdFromInterruptMismatch(error);
          if (!retried && actualTurnId && actualTurnId !== turnId) {
            turnId = actualTurnId;
            state.updateSession(sessionId, (current) => ({ ...current, activeTurnId: actualTurnId }));
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      this.submitPendingAfterInterrupt.delete(sessionId);
      this.setError(sessionId, error, "停止任务失败");
    }
    return false;
  };

  readonly commitPendingSteer = (sessionId: string, clientUserMessageId: string) => {
    this.options.state.replacePendingSteers(sessionId, (current) => current.filter((entry) => entry.clientUserMessageId !== clientUserMessageId));
  };

  readonly handleTurnCompleted = (sessionId: string, turnStatus: string) => {
    const { state, services } = this.options;
    const pending = state.getPendingSteers(sessionId);
    if (turnStatus === "interrupted") {
      const resubmitPending = this.submitPendingAfterInterrupt.delete(sessionId);
      if (resubmitPending && pending.length) {
        state.replacePendingSteers(sessionId, []);
        let nextQueue = state.getQueued(sessionId);
        for (const steer of pending) nextQueue = insertRejectedSteer(nextQueue, steer);
        state.replaceQueued(sessionId, nextQueue);
      } else {
        const queued = state.getQueued(sessionId);
        const rejected = queued.filter((entry) => entry.queueKind === "rejectedSteer");
        const explicit = queued.filter((entry) => entry.queueKind !== "rejectedSteer");
        state.replacePendingSteers(sessionId, []);
        state.replaceQueued(sessionId, []);
        services.restoreMessagesToDraft(sessionId, [...rejected, ...pending, ...explicit]);
      }
      return;
    }
    if (pending.length) {
      state.replacePendingSteers(sessionId, []);
      let nextQueue = state.getQueued(sessionId);
      for (const steer of pending) nextQueue = insertRejectedSteer(nextQueue, steer);
      state.replaceQueued(sessionId, nextQueue);
      return;
    }
    this.submitPendingAfterInterrupt.delete(sessionId);
  };

  release(sessionId: string) {
    this.queueDraining.delete(sessionId);
    this.steerChains.delete(sessionId);
    this.submitPendingAfterInterrupt.delete(sessionId);
  }

  recoverProvider(sessionIds: Iterable<string>) {
    for (const sessionId of sessionIds) {
      this.release(sessionId);
      let queue = this.options.state.getQueued(sessionId);
      for (const steer of this.options.state.getPendingSteers(sessionId)) queue = insertRejectedSteer(queue, steer);
      this.options.state.replaceQueued(sessionId, queue);
      this.options.state.replacePendingSteers(sessionId, []);
    }
  }
}
