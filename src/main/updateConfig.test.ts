import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

describe("desktop update repository configuration", () => {
  it("keeps package publishing and runtime update source on the current remote", () => {
    const root = process.cwd();
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { repository?: { url?: string }; build?: { publish?: Array<{ owner?: string; repo?: string; private?: boolean }> } };
    const workflow = readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
    const updateSource = readFileSync(path.join(root, "src", "main", "desktopUpdateManager.ts"), "utf8");
    assert.match(pkg.repository?.url || "", /github\.com\/yk-yla\/agentdesk\.git/);
    assert.deepEqual(pkg.build?.publish?.[0] && { owner: pkg.build.publish[0].owner, repo: pkg.build.publish[0].repo, private: pkg.build.publish[0].private }, { owner: "yk-yla", repo: "agentdesk", private: false });
    assert.match(workflow, /gh release create/);
    assert.match(workflow, /--notes-file/);
    assert.match(updateSource, /const UPDATE_OWNER = "yk-yla";/);
    assert.match(updateSource, /const UPDATE_REPOSITORY = "agentdesk";/);
    assert.doesNotMatch(`${JSON.stringify(pkg)}\n${workflow}\n${updateSource}`, /yxb715[\\/]codex-desktop/i);
  });
});
