export const MAX_CLIPBOARD_IMAGE_PIXELS = 3_840 * 2_160;
export const MAX_CLIPBOARD_IMAGE_DIMENSION = 8_192;

export function isClipboardImageSizeAllowed(width: number, height: number) {
  return Number.isInteger(width)
    && Number.isInteger(height)
    && width > 0
    && height > 0
    && width <= MAX_CLIPBOARD_IMAGE_DIMENSION
    && height <= MAX_CLIPBOARD_IMAGE_DIMENSION
    && width * height <= MAX_CLIPBOARD_IMAGE_PIXELS;
}

export function fitClipboardImageSize(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("图片尺寸无效。");
  const scale = Math.min(
    1,
    MAX_CLIPBOARD_IMAGE_DIMENSION / width,
    MAX_CLIPBOARD_IMAGE_DIMENSION / height,
    Math.sqrt(MAX_CLIPBOARD_IMAGE_PIXELS / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}
