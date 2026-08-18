export const MAX_LOCAL_IMAGE_BYTES = 10 * 1024 * 1024;

export type LocalImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export function detectImageMediaType(bytes: Buffer): LocalImageMediaType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const signature = bytes.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export function extensionForImageMediaType(mediaType: LocalImageMediaType) {
  return mediaType === "image/jpeg" ? "jpg" : mediaType.slice("image/".length);
}
