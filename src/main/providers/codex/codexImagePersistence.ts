import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { JsonRpcMessage } from "../../../shared/protocol";
import { detectImageMediaType, extensionForImageMediaType, MAX_LOCAL_IMAGE_BYTES, type LocalImageMediaType } from "../../imageContent";

const IMAGE_TYPES = new Set(["imageView", "imageGeneration"]);
const IMAGE_EXTENSIONS: Array<{ extension: string; mediaType: LocalImageMediaType }> = [
  { extension: "png", mediaType: "image/png" },
  { extension: "jpg", mediaType: "image/jpeg" },
  { extension: "gif", mediaType: "image/gif" },
  { extension: "webp", mediaType: "image/webp" },
];
const MAX_VISITED_VALUES = 100_000;

export interface CodexImagePersistenceOptions {
  attachmentRoot: () => string;
  onSaved?: (details: { name: string; size: number }) => void;
  onFailure?: (details: { name: string; reason: string }) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function displayName(filePath: string) {
  return path.basename(filePath) || "图片";
}

function normalizedPath(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithinDirectory(filePath: string, directory: string) {
  const relative = path.relative(normalizedPath(directory), normalizedPath(filePath));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function imageKey(record: Record<string, unknown>, field: string, sourcePath: string) {
  const id = typeof record.id === "string" ? record.id : "";
  return createHash("sha256").update(`${id}\0${field}\0${normalizedPath(sourcePath)}`).digest("hex").slice(0, 32);
}

function targetPath(root: string, key: string, extension: string) {
  return path.join(root, `codex-image-${key}.${extension}`);
}

function readStableImage(filePath: string) {
  const requested = path.resolve(filePath);
  const linkStats = lstatSync(requested);
  if (linkStats.isSymbolicLink()) throw new Error("图片来源不安全，未保存。");
  const canonical = realpathSync(requested);
  const before = statSync(canonical);
  if (!before.isFile()) throw new Error("图片来源不是普通文件，未保存。");
  if (!before.size || before.size > MAX_LOCAL_IMAGE_BYTES) throw new Error("图片超过 10 MB，未保存。");
  const bytes = readFileSync(canonical);
  const after = statSync(canonical);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error("图片在保存过程中发生变化，请重新生成。");
  const mediaType = detectImageMediaType(bytes);
  if (!mediaType) throw new Error("图片内容格式不支持，仅支持 PNG、JPEG、GIF 或 WebP。");
  return { bytes, mediaType };
}

function existingSavedImage(root: string, key: string) {
  for (const entry of IMAGE_EXTENSIONS) {
    const candidate = targetPath(root, key, entry.extension);
    if (!existsSync(candidate)) continue;
    try {
      const stats = statSync(candidate);
      if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_LOCAL_IMAGE_BYTES) continue;
      const bytes = readFileSync(candidate);
      if (detectImageMediaType(bytes) === entry.mediaType) return candidate;
    } catch {
      // A partially written or externally removed copy is treated as missing.
    }
  }
  return null;
}

function saveImageCopy(root: string, key: string, sourcePath: string) {
  const existing = existingSavedImage(root, key);
  if (existing) return { path: existing, size: statSync(existing).size, reused: true };

  const image = readStableImage(sourcePath);
  mkdirSync(root, { recursive: true });
  const target = targetPath(root, key, extensionForImageMediaType(image.mediaType));
  const temporary = path.join(root, `.codex-image-${key}-${randomUUID()}.tmp`);
  try {
    if (existsSync(target)) unlinkSync(target);
    writeFileSync(temporary, image.bytes, { flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    if (existsSync(target)) return { path: target, size: statSync(target).size, reused: true };
    throw error;
  }
  return { path: target, size: image.bytes.length, reused: false };
}

function persistField(record: Record<string, unknown>, field: string, root: string, options: CodexImagePersistenceOptions) {
  const source = record[field];
  if (typeof source !== "string" || !source.trim()) return;
  const name = typeof record.name === "string" && record.name.trim() ? record.name : displayName(source);
  record.name = name;
  const sourcePath = path.resolve(source);
  if (isWithinDirectory(sourcePath, root)) return;
  const key = imageKey(record, field, sourcePath);
  try {
    const saved = saveImageCopy(root, key, sourcePath);
    record[field] = saved.path;
    delete record.imageError;
    options.onSaved?.({ name, size: saved.size });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    const reason = code === "ENOENT"
      ? "原图片已被系统清理，无法恢复。"
      : error instanceof Error && error.message ? error.message : "图片保存失败，无法在会话中长期显示。";
    record.imageError = reason;
    options.onFailure?.({ name, reason });
  }
}

function persistValue(value: unknown, root: string, options: CodexImagePersistenceOptions) {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length && visited < MAX_VISITED_VALUES) {
    const current = pending.pop();
    visited += 1;
    if (Array.isArray(current)) {
      current.forEach((entry) => pending.push(entry));
      continue;
    }
    if (!isRecord(current)) continue;
    const type = current.type;
    if (typeof type === "string" && IMAGE_TYPES.has(type)) {
      if (type === "imageView") {
        persistField(current, "path", root, options);
      } else {
        const result = typeof current.result === "string" ? current.result : "";
        if (/^(?:data:image\/|https?:\/\/)/i.test(result)) {
          if (!current.name && typeof current.savedPath === "string") current.name = displayName(current.savedPath);
        } else {
          const field = typeof current.savedPath === "string" && current.savedPath.trim() ? "savedPath" : "path";
          persistField(current, field, root, options);
          if (field === "path" && typeof current.savedPath !== "string") current.savedPath = current.path;
          if (field === "savedPath" && typeof current.path === "string" && current.path === current.savedPath) current.path = current.savedPath;
        }
      }
    }
    Object.values(current).forEach((entry) => pending.push(entry));
  }
}

export class CodexImagePersistence {
  constructor(private readonly options: CodexImagePersistenceOptions) {}

  transformMessage(message: JsonRpcMessage) {
    try {
      persistValue(message, this.options.attachmentRoot(), this.options);
    } catch (error) {
      this.options.onFailure?.({ name: "图片", reason: error instanceof Error && error.message ? error.message : "图片保存失败，无法在会话中长期显示。" });
    }
    return message;
  }
}
