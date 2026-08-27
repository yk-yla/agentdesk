import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ensureCodexHomeLinks } from "./codexHome";

describe("Codex home links", () => {
  it("shares config and auth while keeping the rest of the home isolated", (context) => {
    const parent = mkdtempSync(path.join(tmpdir(), "agentdesk-codex-home-"));
    const globalHome = path.join(parent, "global");
    const isolatedHome = path.join(parent, "isolated");
    try {
      mkdirSync(globalHome);
      ensureCodexHomeLinks(globalHome, isolatedHome);
      writeFileSync(path.join(globalHome, "config.toml"), "model = \"first\"", { encoding: "utf8", flag: "wx" });
      writeFileSync(path.join(globalHome, "auth.json"), "{}", { encoding: "utf8", flag: "wx" });
      const results = ensureCodexHomeLinks(globalHome, isolatedHome);
      const failed = results.find((result) => result.status === "error");
      if (failed && /EPERM|privilege/i.test(failed.error || "")) {
        context.skip("当前 Windows 环境没有创建文件软链接的权限。");
        return;
      }
      assert.deepEqual(results.map((result) => result.status), ["created", "created"]);
      assert.equal(lstatSync(path.join(isolatedHome, "config.toml")).isSymbolicLink(), true);
      writeFileSync(path.join(globalHome, "config.toml"), "model = \"second\"", "utf8");
      assert.equal(readFileSync(path.join(isolatedHome, "config.toml"), "utf8"), "model = \"second\"");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("backs up an existing private config before linking the global one", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "agentdesk-codex-home-existing-"));
    const globalHome = path.join(parent, "global");
    const isolatedHome = path.join(parent, "isolated");
    try {
      mkdirSync(globalHome);
      ensureCodexHomeLinks(globalHome, isolatedHome);
      writeFileSync(path.join(globalHome, "config.toml"), "global", { encoding: "utf8", flag: "wx" });
      writeFileSync(path.join(isolatedHome, "config.toml"), "private", { encoding: "utf8", flag: "wx" });
      const config = ensureCodexHomeLinks(globalHome, isolatedHome).find((result) => result.fileName === "config.toml");
      assert.equal(config?.status, "created");
      assert.equal(config?.backupPath ? existsSync(config.backupPath) : false, true);
      assert.equal(readFileSync(path.join(isolatedHome, "config.toml"), "utf8"), "global");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
