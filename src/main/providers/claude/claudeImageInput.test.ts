import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareClaudeImageInput, validateVerifiedClaudeImage } from "./claudeImageInput";

const PNG = Buffer.from("89504e470d0a1a0a00000000", "hex");
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");
const GIF = Buffer.from("47494638396101000100", "hex");
const WEBP = Buffer.from("524946460400000057454250", "hex");

describe("Claude image input policy", () => {
  it("accepts the four supported formats by content", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agentdesk-images-"));
    try {
      const authorized = new Set<string>();
      for (const [name, bytes, mediaType] of [
        ["image.bin", PNG, "image/png"],
        ["image.jpg", JPEG, "image/jpeg"],
        ["image.gif", GIF, "image/gif"],
        ["image.webp", WEBP, "image/webp"],
      ] as const) {
        const filePath = path.join(root, name);
        writeFileSync(filePath, bytes);
        authorized.add(filePath);
        const image = prepareClaudeImageInput(filePath, root, authorized);
        assert.equal(image.mediaType, mediaType);
        assert.equal(validateVerifiedClaudeImage(image).mediaType, mediaType);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects outside, traversal, unapproved, oversized and forged files", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "agentdesk-images-reject-"));
    try {
      const root = path.join(parent, "attachments");
      mkdirSync(root);
      const valid = path.join(root, "valid.png");
      const outside = path.join(parent, "outside.png");
      const forged = path.join(root, "forged.png");
      const oversized = path.join(root, "large.png");
      writeFileSync(valid, PNG);
      writeFileSync(outside, PNG);
      writeFileSync(forged, "not an image");
      writeFileSync(oversized, Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]));
      const authorized = new Set([valid, outside, forged, oversized]);
      assert.throws(() => prepareClaudeImageInput(outside, root, authorized), /受控附件目录/);
      assert.throws(() => prepareClaudeImageInput(path.join(root, "..", "outside.png"), root, authorized), /受控附件目录/);
      assert.throws(() => prepareClaudeImageInput(valid, root, new Set()), /未获得授权/);
      assert.throws(() => prepareClaudeImageInput(oversized, root, authorized), /10 MB/);
      assert.throws(() => prepareClaudeImageInput(forged, root, authorized), /图片格式/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects links and does not expose a path to the worker", (test) => {
    const parent = mkdtempSync(path.join(tmpdir(), "agentdesk-images-link-"));
    try {
      const root = path.join(parent, "attachments");
      mkdirSync(root);
      const outside = path.join(parent, "outside.png");
      const linked = path.join(root, "linked.png");
      writeFileSync(outside, PNG);
      try {
        symlinkSync(outside, linked, "file");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
          test.skip("当前 Windows 用户没有创建符号链接的权限。");
          return;
        }
        throw error;
      }
      assert.throws(() => prepareClaudeImageInput(linked, root, new Set([linked])), /链接|受控附件目录/);
      const valid = path.join(root, "valid.png");
      writeFileSync(valid, PNG);
      const image = prepareClaudeImageInput(valid, root, new Set([valid]));
      assert.equal("path" in image, false);
      writeFileSync(valid, "replaced after validation");
      assert.equal(validateVerifiedClaudeImage(image).mediaType, "image/png");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects a worker descriptor whose bytes do not match its declared type", () => {
    assert.throws(() => validateVerifiedClaudeImage({ type: "verifiedImage", mediaType: "image/png", data: JPEG.toString("base64"), size: JPEG.length }), /不匹配/);
  });
});
