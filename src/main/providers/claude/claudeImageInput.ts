import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { JsonObject } from "../../../shared/protocol";

export const MAX_CLAUDE_IMAGE_BYTES = 10 * 1024 * 1024;

export interface VerifiedClaudeImage extends JsonObject {
  type: "verifiedImage";
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
  size: number;
}

function pathKey(value: string) {
  const resolved = realpathSync(path.resolve(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function insideDirectory(filePath: string, directory: string) {
  const relative = path.relative(directory, filePath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function imageMediaType(bytes: Buffer): VerifiedClaudeImage["mediaType"] | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const signature = bytes.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export function validateVerifiedClaudeImage(value: VerifiedClaudeImage): VerifiedClaudeImage {
  if (!value || value.type !== "verifiedImage" || typeof value.data !== "string" || !/^[a-z0-9+/]*={0,2}$/i.test(value.data)) {
    throw new Error("Claude 图片描述无效。");
  }
  const bytes = Buffer.from(value.data, "base64");
  if (!bytes.length || bytes.length > MAX_CLAUDE_IMAGE_BYTES || value.size !== bytes.length) {
    throw new Error("Claude 图片大小必须在 10 MB 以内。");
  }
  const detected = imageMediaType(bytes);
  if (!detected) throw new Error("Claude 图片格式无效，仅支持 PNG、JPEG、GIF 或 WebP。");
  if (detected !== value.mediaType) throw new Error("Claude 图片内容与声明的格式不匹配。");
  return value;
}

export function prepareClaudeImageInput(filePath: string, attachmentRoot: string, authorizedPaths: ReadonlySet<string>): VerifiedClaudeImage {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("Claude 图片路径无效。");
  const requestedPath = path.resolve(filePath);
  const linkStats = lstatSync(requestedPath);
  if (linkStats.isSymbolicLink()) throw new Error("Claude 图片不能使用符号链接或重解析点。");
  const canonicalRoot = pathKey(attachmentRoot);
  const canonicalFile = pathKey(requestedPath);
  if (!insideDirectory(canonicalFile, canonicalRoot)) throw new Error("Claude 图片不在受控附件目录中。");
  const authorized = [...authorizedPaths].some((entry) => {
    try { return pathKey(entry) === canonicalFile; } catch { return false; }
  });
  if (!authorized) throw new Error("Claude 图片路径未获得授权。");

  const descriptor = openSync(canonicalFile, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error("Claude 图片必须是普通文件。");
    if (!before.size || before.size > MAX_CLAUDE_IMAGE_BYTES) throw new Error("Claude 图片大小必须在 10 MB 以内。");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      throw new Error("Claude 图片在校验期间发生变化，请重新添加。");
    }
    const mediaType = imageMediaType(bytes);
    if (!mediaType) throw new Error("Claude 图片格式无效，仅支持 PNG、JPEG、GIF 或 WebP。");
    return validateVerifiedClaudeImage({ type: "verifiedImage", mediaType, data: bytes.toString("base64"), size: bytes.length });
  } finally {
    closeSync(descriptor);
  }
}

export function prepareClaudeTurnParams(params: JsonObject, attachmentRoot: string, authorizedPaths: ReadonlySet<string>): JsonObject {
  if (!Array.isArray(params.input)) return params;
  const input = params.input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Claude 输入块无效。");
    const record = item as JsonObject;
    if (record.type !== "localImage") return record;
    if (typeof record.path !== "string") throw new Error("Claude 图片路径无效。");
    return prepareClaudeImageInput(record.path, attachmentRoot, authorizedPaths);
  });
  return { ...params, input };
}
