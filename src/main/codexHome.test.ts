import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ensureCodexHomeLinks, ensureCodexSkillLinks } from "./codexHome";

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

  it("projects user skills without replacing AgentDesk system skills", (context) => {
    const parent = mkdtempSync(path.join(tmpdir(), "agentdesk-codex-skills-"));
    const globalHome = path.join(parent, "global");
    const isolatedHome = path.join(parent, "isolated");
    const globalSkills = path.join(globalHome, "skills");
    const isolatedSkills = path.join(isolatedHome, "skills");
    try {
      mkdirSync(path.join(globalSkills, "mini-ide"), { recursive: true });
      mkdirSync(path.join(isolatedSkills, ".system"), { recursive: true });
      writeFileSync(path.join(globalSkills, "mini-ide", "SKILL.md"), "name: mini-ide\n", "utf8");
      writeFileSync(path.join(isolatedSkills, ".system", "SKILL.md"), "name: system\n", "utf8");

      const results = ensureCodexSkillLinks(globalHome, isolatedHome);
      const failed = results.find((result) => result.status === "error");
      if (failed && /EPERM|privilege|operation not permitted/i.test(failed.error || "")) {
        context.skip("当前 Windows 环境没有创建目录链接的权限。");
        return;
      }

      assert.equal(results.find((result) => result.name === "mini-ide")?.status, "created");
      assert.equal(lstatSync(path.join(isolatedSkills, "mini-ide")).isSymbolicLink(), true);
      assert.equal(readFileSync(path.join(isolatedSkills, "mini-ide", "SKILL.md"), "utf8"), "name: mini-ide\n");
      assert.equal(readFileSync(path.join(isolatedSkills, ".system", "SKILL.md"), "utf8"), "name: system\n");

      const second = ensureCodexSkillLinks(globalHome, isolatedHome);
      assert.equal(second.find((result) => result.name === "mini-ide")?.status, "linked");

      rmSync(path.join(globalSkills, "mini-ide"), { recursive: true, force: true });
      ensureCodexSkillLinks(globalHome, isolatedHome);
      assert.throws(() => lstatSync(path.join(isolatedSkills, "mini-ide")), /ENOENT|不存在/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not overwrite an unrelated skill directory", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "agentdesk-codex-skills-occupied-"));
    const globalHome = path.join(parent, "global");
    const isolatedHome = path.join(parent, "isolated");
    try {
      mkdirSync(path.join(globalHome, "skills", "shared"), { recursive: true });
      mkdirSync(path.join(isolatedHome, "skills", "shared"), { recursive: true });
      writeFileSync(path.join(globalHome, "skills", "shared", "SKILL.md"), "global\n", "utf8");
      writeFileSync(path.join(isolatedHome, "skills", "shared", "SKILL.md"), "private\n", "utf8");

      const result = ensureCodexSkillLinks(globalHome, isolatedHome).find((entry) => entry.name === "shared");
      assert.equal(result?.status, "occupied");
      assert.equal(readFileSync(path.join(isolatedHome, "skills", "shared", "SKILL.md"), "utf8"), "private\n");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
