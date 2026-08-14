import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseClipboardImageDataUrl } from "./clipboardImageData";

function pngDataUrl(width: number, height: number) {
  const data = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(data);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return `data:image/png;base64,${data.toString("base64")}`;
}

function jpegDataUrl(width: number, height: number) {
  const data = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x11, 0x00]);
  return `data:image/jpeg;base64,${data.toString("base64")}`;
}

describe("clipboard image data", () => {
  it("reads PNG and JPEG dimensions before native decoding", () => {
    const png = parseClipboardImageDataUrl(pngDataUrl(800, 600));
    const jpeg = parseClipboardImageDataUrl(jpegDataUrl(1_200, 900));
    assert.deepEqual({ width: png.width, height: png.height }, { width: 800, height: 600 });
    assert.deepEqual({ width: jpeg.width, height: jpeg.height }, { width: 1_200, height: 900 });
  });

  it("rejects oversized dimensions and mismatched formats", () => {
    assert.throws(() => parseClipboardImageDataUrl(pngDataUrl(50_000, 50_000)), /尺寸过大/);
    assert.throws(() => parseClipboardImageDataUrl(pngDataUrl(0, 100)), /尺寸过大/);
    assert.throws(() => parseClipboardImageDataUrl("data:image/jpeg;base64," + pngDataUrl(100, 100).split(",")[1]), /格式无效/);
  });
});
