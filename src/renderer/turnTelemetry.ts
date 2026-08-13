import type { AgentOperation, AgentProvider } from "../shared/agentProtocol";
import type { JsonObject } from "../shared/protocol";

export type TurnTelemetrySink = (event: string, details?: JsonObject) => void;

interface ActiveTurn {
  runId: string;
  provider: AgentProvider;
  operation: AgentOperation;
  requestedAt: number;
  providerStartedAt?: number;
  firstOutputAt?: number;
  settled: boolean;
}

function duration(now: number, startedAt: number) {
  return Math.max(0, now - startedAt);
}

/** 只记录任务生命周期边界；流式事件由布尔状态去重，不写正文。 */
export class TurnTelemetry {
  private readonly active = new Map<string, ActiveTurn>();
  private sequence = 0;

  constructor(private readonly sink: TurnTelemetrySink, private readonly now: () => number = () => Date.now()) {}

  begin(sessionId: string, provider: AgentProvider, operation: AgentOperation, details: JsonObject = {}) {
    const previous = this.active.get(sessionId);
    if (previous && !previous.settled) this.failed(sessionId, "replaced");
    this.sequence += 1;
    const requestedAt = this.now();
    const runId = `run-${requestedAt}-${this.sequence}`;
    this.active.set(sessionId, { runId, provider, operation, requestedAt, settled: false });
    this.sink("turn.requested", { runId, provider, operation, ...details });
  }

  started(sessionId: string) {
    const current = this.active.get(sessionId);
    if (!current || current.settled || current.providerStartedAt !== undefined) return;
    const at = this.now();
    current.providerStartedAt = at;
    this.sink("turn.started", { runId: current.runId, provider: current.provider, operation: current.operation, waitMs: duration(at, current.requestedAt) });
  }

  firstOutput(sessionId: string, outputKind: string) {
    const current = this.active.get(sessionId);
    if (!current || current.settled || current.firstOutputAt !== undefined) return;
    const at = this.now();
    current.firstOutputAt = at;
    this.sink("turn.first_output", { runId: current.runId, provider: current.provider, operation: current.operation, outputKind, durationMs: duration(at, current.providerStartedAt ?? current.requestedAt) });
  }

  completed(sessionId: string, status: string) {
    const current = this.active.get(sessionId);
    if (!current || current.settled) return;
    current.settled = true;
    const at = this.now();
    const event = status === "interrupted" ? "turn.interrupted" : status === "failed" ? "turn.failed" : "turn.completed";
    this.sink(event, {
      runId: current.runId,
      provider: current.provider,
      operation: current.operation,
      status,
      durationMs: duration(at, current.requestedAt),
      ...(current.providerStartedAt !== undefined ? { providerDurationMs: duration(at, current.providerStartedAt) } : {}),
      ...(current.firstOutputAt !== undefined ? { firstOutputMs: duration(current.firstOutputAt, current.providerStartedAt ?? current.requestedAt) } : {}),
    });
    this.active.delete(sessionId);
  }

  failed(sessionId: string, reason = "request_failed") {
    const current = this.active.get(sessionId);
    if (!current || current.settled) return;
    current.settled = true;
    const at = this.now();
    this.sink("turn.failed", { runId: current.runId, provider: current.provider, operation: current.operation, reason, durationMs: duration(at, current.requestedAt) });
    this.active.delete(sessionId);
  }

  release(sessionId: string) {
    this.active.delete(sessionId);
  }
}
