import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

describe("preload bridge surface", () => {
  it("exposes only the provider-neutral bridge to the renderer", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "preload", "preload.ts"), "utf8");
    const exposed = [...source.matchAll(/contextBridge\.exposeInMainWorld\("([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(exposed, ["agentDesk"]);
  });
});
