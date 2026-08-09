import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyClaudeGatewayFailure } from "./claudeGatewayError";

describe("Claude gateway error classification", () => {
  it("classifies the acceptance matrix without echoing raw secrets", () => {
    const secret = "fixture-secret-value";
    const cases = [
      [new Error(`HTTP 401 invalid x-api-key ${secret}`), "unauthorized", false],
      [new Error("status code 429 rate_limit_error"), "rateLimited", true],
      [new Error("HTTP 503 service unavailable"), "serverError", true],
      [new Error("SSE stream terminated: unexpected end"), "truncatedSse", true],
      [new Error("UND_ERR_HEADERS_TIMEOUT"), "timeout", true],
      [new Error("connect ECONNREFUSED 127.0.0.1"), "offline", true],
    ] as const;
    for (const [error, kind, retryable] of cases) {
      const result = classifyClaudeGatewayFailure(error);
      assert.equal(result.kind, kind);
      assert.equal(result.retryable, retryable);
      assert.equal(result.message.includes(secret), false);
    }
  });

  it("uses a controlled fixture hint only when the SDK error is generic", () => {
    assert.equal(classifyClaudeGatewayFailure("process exited with code 1", "truncatedSse").kind, "truncatedSse");
  });
});

