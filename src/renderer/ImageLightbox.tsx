import { Check, Copy, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { fitClipboardImageSize, isClipboardImageSizeAllowed } from "../shared/imagePolicy";

interface Props {
  source: string;
  label: string;
  copyImage: (dataUrl: string) => Promise<void>;
  onClose: () => void;
}

function imageDataUrlForClipboard(source: string, image: HTMLImageElement) {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw new Error("图片尚未加载完成。");
  if (/^data:image\/(?:png|jpeg);base64,/i.test(source) && isClipboardImageSizeAllowed(width, height)) return source;
  const fitted = fitClipboardImageSize(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = fitted.width;
  canvas.height = fitted.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法读取图片像素。");
  context.drawImage(image, 0, 0, fitted.width, fitted.height);
  return canvas.toDataURL("image/png");
}

export default function ImageLightbox({ source, label, copyImage, onClose }: Props) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const copy = async () => {
    const image = imageRef.current;
    if (!image) return;
    try {
      await copyImage(imageDataUrlForClipboard(source, image));
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1_200);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1_800);
    }
  };

  return createPortal(
    <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <div className="image-lightbox-actions" onClick={(event) => event.stopPropagation()}>
        <button type="button" className={copyState === "failed" ? "image-lightbox-action failed" : "image-lightbox-action"} onClick={() => void copy()} title={copyState === "copied" ? "已复制图片" : copyState === "failed" ? "复制失败" : "复制图片"} aria-label={copyState === "copied" ? "已复制图片" : "复制图片"}>
          {copyState === "copied" ? <Check size={18} /> : <Copy size={18} />}
        </button>
        <button type="button" className="image-lightbox-action" onClick={onClose} title="关闭预览" aria-label="关闭预览"><X size={19} /></button>
      </div>
      <img ref={imageRef} src={source} alt="放大预览" onClick={(event) => event.stopPropagation()} />
    </div>,
    document.body,
  );
}
