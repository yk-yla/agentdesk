import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareAgentRequest } from "./requestAdapterRegistry";

describe("main provider request adapters", () => {
  it("applies Claude input security only inside the Claude adapter", () => {
    const params = { input: [] };
    const prepare = () => ({ verified: true });
    assert.equal(prepareAgentRequest("codex", "startTurn", params, prepare), params);
    assert.deepEqual(prepareAgentRequest("claude", "startTurn", params, prepare), { verified: true });
    assert.equal(prepareAgentRequest("claude", "listSessions", params, prepare), params);
  });
});
