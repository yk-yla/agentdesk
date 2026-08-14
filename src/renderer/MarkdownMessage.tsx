import { Check, Copy } from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ImageAttachment } from "./domain";
import ImageLightbox from "./ImageLightbox";

interface Props {
  text: string;
  images?: ImageAttachment[];
  streaming?: boolean;
  readLocalImage: (path: string) => Promise<string | null>;
  copyImage: (dataUrl: string) => Promise<void>;
  openLocalPath: (path: string) => Promise<string>;
  openExternal: (url: string) => Promise<void>;
}

/** 模块级常量：避免每次渲染都创建新的插件数组，触发 react-markdown 重建管线。 */
const REMARK_PLUGINS = [remarkGfm];
const NO_IMAGES: ImageAttachment[] = [];
const LOCAL_IMAGE_CACHE_LIMIT = 8;
const localImageCache = new Map<string, Promise<string | null>>();

function readCachedLocalImage(path: string, reader: Props["readLocalImage"]) {
  const cached = localImageCache.get(path);
  if (cached) {
    localImageCache.delete(path);
    localImageCache.set(path, cached);
    return cached;
  }
  const pending = reader(path).catch(() => null).then((value) => {
    if (!value) localImageCache.delete(path);
    return value;
  });
  localImageCache.set(path, pending);
  while (localImageCache.size > LOCAL_IMAGE_CACHE_LIMIT) {
    const oldest = localImageCache.keys().next().value as string | undefined;
    if (!oldest) break;
    localImageCache.delete(oldest);
  }
  return pending;
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function localPathFromHref(value: string) {
  const decoded = safeDecodeURIComponent(value.replace(/^file:\/\//, ""));
  return /^\/[a-z]:[\\/]/i.test(decoded) ? decoded.slice(1) : decoded;
}

function isHttpSource(value: string) {
  return value.startsWith("http://") || value.startsWith("https://");
}

function AttachmentImage({ image, readLocalImage, openExternal, onOpen }: { image: ImageAttachment; readLocalImage: Props["readLocalImage"]; openExternal: Props["openExternal"]; onOpen?: (source: string) => void }) {
  const [source, setSource] = useState(image.dataUrl);
  useEffect(() => {
    let active = true;
    if (!source && image.path) void readCachedLocalImage(image.path, readLocalImage).then((value) => { if (active && value) setSource(value); });
    return () => { active = false; };
  }, [image.dataUrl, image.path, readLocalImage, source]);
  if (source && isHttpSource(source)) {
    return <a className="image-placeholder" href={source} onClick={(event) => { event.preventDefault(); void openExternal(source); }}>远程图片：{image.name}</a>;
  }
  return source
    ? <img className="message-image" src={source} alt={image.name} onClick={() => onOpen?.(source)} title="点击放大" />
    : <span className="image-placeholder">图片不可用或已清理：{image.name}</span>;
}

function nodeText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(nodeText).join("");
  if (value && typeof value === "object" && "props" in value) return nodeText((value as { props: { children?: ReactNode } }).props.children);
  return "";
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(nodeText(children).replace(/\n$/, ""));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  return <pre className="markdown-pre"><div className="code-copy-row"><span>代码</span><button onClick={() => void copy()} title="复制代码" aria-label="复制代码">{copied ? <Check size={12} /> : <Copy size={12} />}</button></div>{children}</pre>;
}

/**
 * memo + 稳定的 plugins/components 引用：
 * 未变化的历史消息不再随任意状态变化重新执行 Markdown/GFM 解析。
 */
function MarkdownMessageBase({ text, images = NO_IMAGES, streaming = false, readLocalImage, copyImage, openLocalPath, openExternal }: Props) {
  const [previewSource, setPreviewSource] = useState<string | null>(null);

  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href?.startsWith("http://") || href?.startsWith("https://")) void openExternal(href); else if (href) void openLocalPath(localPathFromHref(href)); }}>{children}</a>,
    img: ({ src, alt }) => src ? (src.startsWith("data:image/")
      ? <img className="message-image" src={src} alt={alt || "图片"} onClick={() => setPreviewSource(src)} title="点击放大" />
      : isHttpSource(src)
        ? <a className="image-placeholder" href={src} onClick={(event) => { event.preventDefault(); void openExternal(src); }}>远程图片：{alt || "图片"}</a>
        : <AttachmentImage image={{ path: localPathFromHref(src), dataUrl: "", name: alt || "图片" }} readLocalImage={readLocalImage} openExternal={openExternal} onOpen={setPreviewSource} />) : null,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    code: ({ className, children, ...props }) => <code className={`markdown-code ${className || ""}`} {...props}>{children}</code>,
  }), [readLocalImage, openLocalPath, openExternal]);

  return (
    <div className="markdown-message">
      {images.length ? <div className="message-images">{images.map((image, index) => <AttachmentImage key={`${image.path}-${index}`} image={image} readLocalImage={readLocalImage} openExternal={openExternal} onOpen={setPreviewSource} />)}</div> : null}
      {text ? (streaming
        ? <div className="streaming-plain-text">{text}</div>
        : <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>{text}</ReactMarkdown>) : null}
      {previewSource ? <ImageLightbox source={previewSource} label="图片预览" copyImage={copyImage} onClose={() => setPreviewSource(null)} /> : null}
    </div>
  );
}

export default memo(MarkdownMessageBase);
