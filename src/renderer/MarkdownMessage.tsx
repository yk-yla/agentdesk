import { Check, Copy, TriangleAlert, X } from "lucide-react";
import { cloneElement, isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ImageAttachment } from "./domain";
import ImageLightbox from "./ImageLightbox";
import { classifyLocalLink } from "./localFileLink";
import type { LocalPathOpenRequest } from "../shared/protocol";
import { LIGHTWEIGHT_NOTICE_DURATION_MS } from "./sessionErrorNotice";
import { useAutoDismissNotice } from "./useAutoDismissNotice";

interface Props {
  text: string;
  images?: ImageAttachment[];
  streaming?: boolean;
  readLocalImage: (path: string) => Promise<string | null>;
  copyImage: (dataUrl: string) => Promise<void>;
  openLocalPath: (input: LocalPathOpenRequest) => Promise<string>;
  openExternal: (url: string) => Promise<void>;
  cwd: string;
  searchTerm?: string;
  activeSearchOccurrence?: number | null;
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

function isHttpSource(value: string) {
  return /^https?:\/\//i.test(value);
}

function AttachmentImage({ image, readLocalImage, openExternal, onOpen }: { image: ImageAttachment; readLocalImage: Props["readLocalImage"]; openExternal: Props["openExternal"]; onOpen?: (source: string) => void }) {
  const [source, setSource] = useState(image.dataUrl);
  const [loading, setLoading] = useState(!image.dataUrl && Boolean(image.path) && !image.error);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { setDismissed(false); }, [image.dataUrl, image.error, image.path]);
  useEffect(() => {
    let active = true;
    if (image.dataUrl) {
      setSource(image.dataUrl);
      setLoading(false);
      return () => { active = false; };
    }
    if (!image.path || image.error) {
      setSource("");
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    void readCachedLocalImage(image.path, readLocalImage).then((value) => {
      if (!active) return;
      if (value) setSource(value);
      setLoading(false);
    });
    return () => { active = false; };
  }, [image.dataUrl, image.path, image.error, readLocalImage]);
  if (source && isHttpSource(source)) {
    return <a className="image-placeholder" href={source} onClick={(event) => { event.preventDefault(); void openExternal(source); }}>远程图片：{image.name}</a>;
  }
  if (loading) return <span className="image-placeholder">正在加载图片...</span>;
  if (dismissed) return null;
  return source
    ? <img className="message-image" src={source} alt={image.name} onClick={() => onOpen?.(source)} title="点击放大" />
    : <span className={"image-placeholder" + (image.error ? " image-placeholder-error" : "")} role={image.error ? "alert" : undefined}>
      {image.error ? <TriangleAlert size={14} aria-hidden="true" /> : null}
      <span>{image.error ? "图片无法显示：" + image.error : "图片无法显示：原文件不存在或已被清理。" + image.name}</span>
      <button type="button" className="bare-button image-error-dismiss" onClick={() => setDismissed(true)} title="关闭错误提示" aria-label="关闭错误提示"><X size={13} /></button>
    </span>;
}

function nodeText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(nodeText).join("");
  if (value && typeof value === "object" && "props" in value) return nodeText((value as { props: { children?: ReactNode } }).props.children);
  return "";
}

function highlightChildren(value: ReactNode, searchTerm: string): ReactNode {
  if (!searchTerm) return value;
  if (typeof value === "string") {
    const normalized = value.toLocaleLowerCase();
    const pieces: ReactNode[] = [];
    let fromIndex = 0;
    let matchIndex = normalized.indexOf(searchTerm, fromIndex);
    let key = 0;
    while (matchIndex >= 0) {
      if (matchIndex > fromIndex) pieces.push(value.slice(fromIndex, matchIndex));
      pieces.push(<mark className="message-search-match" key={`match-${key++}`}>{value.slice(matchIndex, matchIndex + searchTerm.length)}</mark>);
      fromIndex = matchIndex + searchTerm.length;
      matchIndex = normalized.indexOf(searchTerm, fromIndex);
    }
    if (!pieces.length) return value;
    if (fromIndex < value.length) pieces.push(value.slice(fromIndex));
    return pieces;
  }
  if (Array.isArray(value)) return value.map((child) => highlightChildren(child, searchTerm));
  if (!isValidElement<{ children?: ReactNode }>(value) || value.type === "mark") return value;
  return cloneElement(value, undefined, highlightChildren(value.props.children, searchTerm));
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
function MarkdownMessageBase({ text, images = NO_IMAGES, streaming = false, readLocalImage, copyImage, openLocalPath, openExternal, cwd, searchTerm = "", activeSearchOccurrence = null }: Props) {
  const [previewSource, setPreviewSource] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const linkErrorAutoDismissProps = useAutoDismissNotice(linkError, linkError ? LIGHTWEIGHT_NOTICE_DURATION_MS : null, () => setLinkError(null));
  const normalizedSearchTerm = searchTerm.trim().toLocaleLowerCase();
  const markdownRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const marks = markdownRootRef.current?.querySelectorAll<HTMLElement>(".message-search-match");
    if (!marks) return;
    marks.forEach((mark) => mark.classList.remove("active"));
    if (activeSearchOccurrence !== null && activeSearchOccurrence !== undefined) {
      marks[activeSearchOccurrence]?.classList.add("active");
    }
  }, [activeSearchOccurrence, normalizedSearchTerm, text]);

  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => {
      const link = href ? classifyLocalLink(href, cwd) : { kind: "unsupported" as const, value: "" };
      if (link.kind === "anchor") return <a href={href}>{highlightChildren(children, normalizedSearchTerm)}</a>;
      if (link.kind === "unsupported") return <a>{highlightChildren(children, normalizedSearchTerm)}</a>;
      return <a href={href} onClick={(event) => {
        event.preventDefault();
        setLinkError(null);
        void (async () => {
          try {
            const result = link.kind === "external"
              ? await openExternal(link.value)
              : await openLocalPath({ path: link.value, cwd });
            if (typeof result === "string" && result.trim()) setLinkError(result.trim());
          } catch (error) {
            setLinkError(error instanceof Error && error.message ? error.message : "打开链接失败。");
          }
        })();
      }}>{highlightChildren(children, normalizedSearchTerm)}</a>;
    },
    img: ({ src, alt }) => src ? (src.startsWith("data:image/")
      ? <img className="message-image" src={src} alt={alt || "图片"} onClick={() => setPreviewSource(src)} title="点击放大" />
      : isHttpSource(src)
        ? <a className="image-placeholder" href={src} onClick={(event) => { event.preventDefault(); void openExternal(src); }}>远程图片：{alt || "图片"}</a>
        : <AttachmentImage image={{ path: classifyLocalLink(src, cwd).value, dataUrl: "", name: alt || "图片" }} readLocalImage={readLocalImage} openExternal={openExternal} onOpen={setPreviewSource} />) : null,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    code: ({ className, children, ...props }) => <code className={`markdown-code ${className || ""}`} {...props}>{highlightChildren(children, normalizedSearchTerm)}</code>,
    p: ({ children }) => <p>{highlightChildren(children, normalizedSearchTerm)}</p>,
    h1: ({ children }) => <h1>{highlightChildren(children, normalizedSearchTerm)}</h1>,
    h2: ({ children }) => <h2>{highlightChildren(children, normalizedSearchTerm)}</h2>,
    h3: ({ children }) => <h3>{highlightChildren(children, normalizedSearchTerm)}</h3>,
    h4: ({ children }) => <h4>{highlightChildren(children, normalizedSearchTerm)}</h4>,
    h5: ({ children }) => <h5>{highlightChildren(children, normalizedSearchTerm)}</h5>,
    h6: ({ children }) => <h6>{highlightChildren(children, normalizedSearchTerm)}</h6>,
    li: ({ children }) => <li>{highlightChildren(children, normalizedSearchTerm)}</li>,
    blockquote: ({ children }) => <blockquote>{highlightChildren(children, normalizedSearchTerm)}</blockquote>,
    em: ({ children }) => <em>{highlightChildren(children, normalizedSearchTerm)}</em>,
    strong: ({ children }) => <strong>{highlightChildren(children, normalizedSearchTerm)}</strong>,
    del: ({ children }) => <del>{highlightChildren(children, normalizedSearchTerm)}</del>,
    td: ({ children }) => <td>{highlightChildren(children, normalizedSearchTerm)}</td>,
    th: ({ children }) => <th>{highlightChildren(children, normalizedSearchTerm)}</th>,
  }), [cwd, normalizedSearchTerm, readLocalImage, openLocalPath, openExternal]);

  return (
    <div className="markdown-message" ref={markdownRootRef}>
      {images.length ? <div className="message-images">{images.map((image, index) => <AttachmentImage key={`${image.path}-${index}`} image={image} readLocalImage={readLocalImage} openExternal={openExternal} onOpen={setPreviewSource} />)}</div> : null}
      {text ? (streaming
        ? <div className="streaming-plain-text">{highlightChildren(text, normalizedSearchTerm)}</div>
        : <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components} urlTransform={(value) => value}>{text}</ReactMarkdown>) : null}
      {linkError ? <div className="markdown-link-error" role="alert" {...linkErrorAutoDismissProps}><span>{linkError}</span><button type="button" className="bare-button" onClick={() => setLinkError(null)} title="关闭错误提示" aria-label="关闭错误提示"><X size={13} /></button></div> : null}
      {previewSource ? <ImageLightbox source={previewSource} label="图片预览" copyImage={copyImage} onClose={() => setPreviewSource(null)} /> : null}
    </div>
  );
}

export default memo(MarkdownMessageBase);
