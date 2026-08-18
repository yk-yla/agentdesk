import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { CodexImagePersistence } from "./codexImagePersistence";

function jpegBytes() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
}

function imageMessage(sourcePath: string, id = "image-item-1") {
  return {
    method: "item/completed",
    params: { item: { id, type: "imageView", path: sourcePath } },
  };
}

describe("Codex image persistence", () => {
  it("copies an external image and reuses the same copy when history is reread", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentdesk-image-test-"));
    const sourcePath = path.join(root, "t0180.jpg");
    const attachmentRoot = path.join(root, "attachments");
    const bytes = jpegBytes();
    writeFileSync(sourcePath, bytes);
    try {
      const first = new CodexImagePersistence({ attachmentRoot: () => attachmentRoot });
      const live = imageMessage(sourcePath);
      first.transformMessage(live);
      const liveItem = live.params.item as unknown as { path: string; name: string };
      assert.notEqual(liveItem.path, sourcePath);
      assert.equal(liveItem.name, "t0180.jpg");
      assert.deepEqual(readFileSync(liveItem.path), bytes);

      rmSync(sourcePath);
      const history = imageMessage(sourcePath);
      new CodexImagePersistence({ attachmentRoot: () => attachmentRoot }).transformMessage(history);
      const historyItem = history.params.item as unknown as { path: string; imageError?: string };
      assert.equal(historyItem.path, liveItem.path);
      assert.equal(historyItem.imageError, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a visible reason when the source cannot be saved", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentdesk-image-test-"));
    try {
      const message = imageMessage(path.join(root, "missing.jpg"));
      new CodexImagePersistence({ attachmentRoot: () => path.join(root, "attachments") }).transformMessage(message);
      const item = message.params.item as unknown as { imageError?: string; name?: string };
      assert.match(item.imageError || "", /清理|保存/);
      assert.equal(item.name, "missing.jpg");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists generated image paths from the savedPath field", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentdesk-image-test-"));
    const sourcePath = path.join(root, "generated.webp");
    const attachmentRoot = path.join(root, "attachments");
    writeFileSync(sourcePath, Buffer.from("RIFF0000WEBP"));
    try {
      const message = {
        method: "item/completed",
        params: { item: { id: "generated-1", type: "imageGeneration", savedPath: sourcePath, result: "" } },
      };
      new CodexImagePersistence({ attachmentRoot: () => attachmentRoot }).transformMessage(message);
      const item = message.params.item as unknown as { savedPath: string; name: string };
      assert.notEqual(item.savedPath, sourcePath);
      assert.equal(item.name, "generated.webp");
      assert.deepEqual(readFileSync(item.savedPath), Buffer.from("RIFF0000WEBP"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
