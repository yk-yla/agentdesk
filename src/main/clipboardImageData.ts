import { isClipboardImageSizeAllowed } from "../shared/imagePolicy";

const MAX_CLIPBOARD_DATA_URL_LENGTH = 56 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG_START_OF_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function pngDimensions(data: Buffer) {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function jpegDimensions(data: Buffer) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < data.length) {
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    if (offset >= data.length) return null;
    const marker = data[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) return null;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return null;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (length < 7) return null;
      return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

export function parseClipboardImageDataUrl(dataUrl: string) {
  const trimmed = dataUrl.trim();
  if (trimmed.length > MAX_CLIPBOARD_DATA_URL_LENGTH) throw new Error("待复制图片无效或过大。");
  const match = /^data:(image\/(?:png|jpeg));base64,([a-z0-9+/=\s]+)$/i.exec(trimmed);
  if (!match) throw new Error("待复制图片无效或过大。");
  const data = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  const dimensions = match[1].toLowerCase() === "image/png" ? pngDimensions(data) : jpegDimensions(data);
  if (!dimensions) throw new Error("待复制图片格式无效。");
  if (!isClipboardImageSizeAllowed(dimensions.width, dimensions.height)) throw new Error("图片尺寸过大，请缩小后复制。");
  return { data, ...dimensions };
}
