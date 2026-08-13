import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ClaudeUpdateManager, downloadClaudeArchive, isTrustedClaudeDownloadUrl, officialClaudeDownloadUrl } from "./claudeUpdateManager";

describe("ClaudeUpdateManager", () => {
  it("accepts only HTTPS release hosts used by the managed updater", () => {
    assert.equal(isTrustedClaudeDownloadUrl("https://github.com/anthropics/claude-code"), true);
    assert.equal(isTrustedClaudeDownloadUrl("https://objects.githubusercontent.com/file"), true);
    assert.equal(isTrustedClaudeDownloadUrl("http://github.com/file"), false);
    assert.equal(isTrustedClaudeDownloadUrl("https://github.com.attacker.example/file"), false);
  });

  it("checks a managed binary without changing it", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-claude-update-"));
    const executable = path.join(directory, "claude.exe");
    writeFileSync(executable, "fixture", "utf8");
    try {
      const manager = new ClaudeUpdateManager({
        appPath: () => directory,
        userDataPath: () => directory,
        fetch: async () => new Response(JSON.stringify({ tag_name: "v1.1.0" }), { status: 200, headers: { "content-type": "application/json" } }),
        shutdownQueries: async () => undefined,
        emitStatus: () => undefined,
        managedExecutablePath: () => executable,
        readSdkVersion: () => "1.0.0",
        readBinaryVersion: () => "1.0.0",
        credentialStatus: () => ({ credentialsAvailable: true, credentialSource: "settings", credentialMessage: "ok" }),
      });

      const status = await manager.check();
      assert.equal(status.phase, "available");
      assert.equal(status.latestVersion, "1.1.0");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the official archive before the proxy and records the source URL", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-claude-download-"));
    const target = path.join(directory, "claude.zip");
    const calls: string[] = [];
    try {
      const source = await downloadClaudeArchive({
        target,
        version: "1.2.3",
        proxyUrl: "https://gh-proxy.com/https://github.com/anthropics/claude-code/releases/download/v1.2.3/claude-win32-x64.zip",
        fetch: async (url) => {
          calls.push(url);
          return new Response(new Uint8Array([80, 75, 3, 4]), { status: 200 });
        },
      });
      assert.equal(source, "official");
      assert.deepEqual(calls, [officialClaudeDownloadUrl("1.2.3")]);
      assert.deepEqual([...readFileSync(target)], [80, 75, 3, 4]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cleans a partial official download before falling back to the proxy", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-claude-download-"));
    const target = path.join(directory, "claude.zip");
    const calls: string[] = [];
    const proxyUrl = "https://gh-proxy.com/https://github.com/anthropics/claude-code/releases/download/v1.2.3/claude-win32-x64.zip";
    try {
      const source = await downloadClaudeArchive({
        target,
        version: "1.2.3",
        proxyUrl,
        fetch: async (url) => {
          calls.push(url);
          if (calls.length === 1) {
            let readCount = 0;
            const body = new ReadableStream<Uint8Array>({
              pull(controller) {
                if (readCount === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
                else controller.error(new Error("官方连接中断"));
                readCount += 1;
              },
            });
            return new Response(body, { status: 200 });
          }
          return new Response(new Uint8Array([9, 8, 7]), { status: 200 });
        },
      });
      assert.equal(source, "proxy");
      assert.deepEqual(calls, [officialClaudeDownloadUrl("1.2.3"), proxyUrl]);
      assert.deepEqual([...readFileSync(target)], [9, 8, 7]);
      assert.equal(existsSync(target), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps official and proxy failures visible and removes the failed archive", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-claude-download-"));
    const target = path.join(directory, "claude.zip");
    const proxyUrl = "https://gh-proxy.com/https://github.com/anthropics/claude-code/releases/download/v1.2.3/claude-win32-x64.zip";
    try {
      await assert.rejects(
        () => downloadClaudeArchive({
          target,
          version: "1.2.3",
          proxyUrl,
          fetch: async (url) => new Response(null, { status: url === officialClaudeDownloadUrl("1.2.3") ? 503 : 502 }),
        }),
        (error: Error) => {
          assert.match(error.message, /官方源失败/);
          assert.match(error.message, /代理回退失败/);
          return true;
        },
      );
      assert.equal(existsSync(target), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an untrusted redirect target without writing the archive", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-claude-download-"));
    const target = path.join(directory, "claude.zip");
    try {
      await assert.rejects(
        () => downloadClaudeArchive({
          target,
          version: "1.2.3",
          proxyUrl: null,
          fetch: async () => new Response(null, { status: 302, headers: { location: "https://attacker.example/claude.zip" } }),
        }),
        /下载地址或重定向目标不受信任/,
      );
      assert.equal(existsSync(target), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports the source after installing a verified pending update", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentdesk-claude-install-"));
    const managed = path.join(directory, "managed", "claude.exe");
    const pendingDirectory = path.join(directory, "pending");
    const extracted = path.join(pendingDirectory, "claude.exe");
    try {
      mkdirSync(path.dirname(managed), { recursive: true });
      writeFileSync(managed, "MZ-old", "utf8");
      mkdirSync(pendingDirectory, { recursive: true });
      writeFileSync(extracted, "MZ-new", "utf8");
      const manager = new ClaudeUpdateManager({
        appPath: () => directory,
        userDataPath: () => directory,
        fetch: async () => new Response(JSON.stringify({ tag_name: "v1.1.0" }), { status: 200 }),
        shutdownQueries: async () => undefined,
        emitStatus: () => undefined,
        managedExecutablePath: () => managed,
        readSdkVersion: () => "1.0.0",
        readBinaryVersion: () => "1.1.0",
        credentialStatus: () => ({ credentialsAvailable: true, credentialSource: "settings", credentialMessage: "ok" }),
      });
      await manager.check();
      (manager as unknown as { pendingUpdate: unknown }).pendingUpdate = {
        directory: pendingDirectory,
        executable: extracted,
        version: "1.1.0",
        signatureValid: true,
        signer: 'CN="Anthropic, PBC", O="Anthropic, PBC"',
        signatureStatus: "Valid",
        downloadSource: "proxy",
      };
      const status = await manager.update(false);
      assert.equal(status.phase, "updated");
      assert.match(status.message, /代理回退/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
