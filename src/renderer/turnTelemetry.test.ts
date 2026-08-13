import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TurnTelemetry } from "./turnTelemetry";

describe("TurnTelemetry", () => {
  it("deduplicates first output and settles a turn once", () => {
    let now = 100;
    const events: Array<{ event: string; details: Record<string, unknown> }> = [];
    const telemetry = new TurnTelemetry((event, details = {}) => events.push({ event, details }), () => now);

    telemetry.begin("session", "codex", "startTurn");
    now = 130;
    telemetry.started("session");
    now = 180;
    telemetry.firstOutput("session", "message");
    telemetry.firstOutput("session", "activity");
    now = 250;
    telemetry.completed("session", "completed");
    telemetry.completed("session", "completed");

    assert.deepEqual(events.map((entry) => entry.event), ["turn.requested", "turn.started", "turn.first_output", "turn.completed"]);
    assert.equal(events[2].details.durationMs, 50);
    assert.equal(events[3].details.durationMs, 150);
    assert.equal(events[3].details.providerDurationMs, 120);
  });

  it("records request failures and releases the active turn", () => {
    let now = 10;
    const events: string[] = [];
    const telemetry = new TurnTelemetry((event) => events.push(event), () => now);

    telemetry.begin("session", "claude", "startTurn");
    now = 25;
    telemetry.failed("session", "timeout");
    telemetry.firstOutput("session", "message");

    assert.deepEqual(events, ["turn.requested", "turn.failed"]);
  });
});
