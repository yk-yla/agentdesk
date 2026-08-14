import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { verifyWorkerLocalMarketplacePath } from "./claudeMarketplacePolicy";

describe("Claude marketplace Worker policy", () => {
  it("accepts workspace paths and the exact main-process-authorized external path", (test) => {
    const workspace = mkdtempSync(path.join(tmpdir(), "agentdesk-marketplace-worker-"));
    const local = path.join(workspace, "local");
    const external = mkdtempSync(path.join(tmpdir(), "agentdesk-marketplace-external-"));
    mkdirSync(local);
    test.after(() => rmSync(workspace, { recursive: true, force: true }));
    test.after(() => rmSync(external, { recursive: true, force: true }));

    assert.equal(verifyWorkerLocalMarketplacePath(local, workspace), local);
    assert.equal(verifyWorkerLocalMarketplacePath(external, workspace, external), external);
  });

  it("rejects a forged external authorization path", (test) => {
    const workspace = mkdtempSync(path.join(tmpdir(), "agentdesk-marketplace-worker-"));
    const external = mkdtempSync(path.join(tmpdir(), "agentdesk-marketplace-external-"));
    const forged = mkdtempSync(path.join(tmpdir(), "agentdesk-marketplace-forged-"));
    test.after(() => rmSync(workspace, { recursive: true, force: true }));
    test.after(() => rmSync(external, { recursive: true, force: true }));
    test.after(() => rmSync(forged, { recursive: true, force: true }));

    assert.throws(() => verifyWorkerLocalMarketplacePath(external, workspace, forged), /未获得主进程授权/);
  });
});
