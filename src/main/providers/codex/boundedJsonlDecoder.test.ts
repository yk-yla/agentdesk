import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BoundedJsonlDecoder, rpcResponseIdFromPrefix } from "./boundedJsonlDecoder";

describe("bounded Codex JSONL decoder", () => {
  it("drops one oversized line and continues with the next response", () => {
    const lines: string[] = [];
    const oversized: Array<{ bytes: number; prefix: string }> = [];
    const decoder = new BoundedJsonlDecoder(32, 24, (line) => lines.push(line), (line) => oversized.push(line));

    decoder.push('{"id":7,"result":"');
    decoder.push(`${"x".repeat(40)}"}\n{"id":8,"result":true}\n`);

    assert.equal(oversized.length, 1);
    assert.ok(oversized[0].bytes > 32);
    assert.equal(rpcResponseIdFromPrefix(oversized[0].prefix), 7);
    assert.deepEqual(lines, ['{"id":8,"result":true}']);
  });

  it("does not mistake a nested or notification id for a response id", () => {
    assert.equal(rpcResponseIdFromPrefix('{"method":"event","params":{"id":9}}'), null);
    assert.equal(rpcResponseIdFromPrefix('{"id":11,"error":{"id":12}}'), 11);
  });
});
