import { ChevronDown, Clock3, CornerDownRight, FolderOpen, ImagePlus, X } from "lucide-react";
import { memo, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import CommandSuggestions from "./CommandSuggestionMenu";
import { useCommandSuggestions, type CommandSuggestion, type CommandUsage } from "./commandSuggestions";
import { type ImageAttachment, type PendingSteerMessage, type QueuedMessage, type SkillOption } from "./domain";
import ImageLightbox from "./ImageLightbox";
import type { AgentCapabilities } from "../shared/agentProtocol";

interface Props {
  sessionId: string;
  cwd: string;
  threadId: string | null;
  skills: SkillOption[];
  recentCommandUsage: CommandUsage;
  capabilities: AgentCapabilities;
  attachments: ImageAttachment[];
  queuedMessages: QueuedMessage[];
  pendingSteers: PendingSteerMessage[];
  working: boolean;
  toolbar: ReactNode;
  copyImage: (dataUrl: string) => Promise<void>;
  getDraft: (sessionId: string) => string;
  onDraftChange: (sessionId: string, value: string) => void;
  onSend: (sessionId: string, text: string, mode?: "submit" | "queue") => void;
  onCycleEffort: (sessionId: string, direction: 1 | -1) => void;
  onAddImages: (sessionId: string, files: File[]) => void;
  onRemoveImage: (sessionId: string, index: number) => void;
  onRemoveQueuedMessage: (sessionId: string, queuedId: string) => void;
  onChooseDirectory: (sessionId: string) => void;
}

/**
 * 草稿是组件内部状态，只写入外部的草稿表用于切 Tab 保留。
 * 打字不再触发顶层 setSessions，因此不会重渲染消息流。
 */
function ComposerBase({
  sessionId, cwd, threadId, skills, recentCommandUsage, capabilities, attachments, queuedMessages, pendingSteers, working, toolbar,
  copyImage, getDraft, onDraftChange, onSend, onCycleEffort, onAddImages, onRemoveImage,
  onRemoveQueuedMessage, onChooseDirectory,
}: Props) {
  const [value, setValue] = useState(() => getDraft(sessionId));
  const [dragging, setDragging] = useState(false);
  const [previewSource, setPreviewSource] = useState<string | null>(null);
  const [dismissedSuggestionsFor, setDismissedSuggestionsFor] = useState<string | null>(null);
  const { suggestions, selectedIndex, moveSelection, selectIndex } = useCommandSuggestions(value, skills, capabilities, recentCommandUsage);
  const visibleSuggestions = dismissedSuggestionsFor === value ? [] : suggestions;

  const update = (next: string) => {
    setValue(next);
    setDismissedSuggestionsFor(null);
    onDraftChange(sessionId, next);
  };

  const submit = (mode: "submit" | "queue" = "submit") => {
    const text = value.trim();
    if (!text && !attachments.length) return;
    update("");
    onSend(sessionId, text, mode);
  };

  const acceptSuggestion = (suggestion: CommandSuggestion) => {
    const prefix = value.match(/^(\s*)/)?.[1] || "";
    update(`${prefix}/${suggestion.name} `);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (visibleSuggestions.length && event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (visibleSuggestions.length && event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (visibleSuggestions.length && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const suggestion = visibleSuggestions[selectedIndex];
      if (suggestion) acceptSuggestion(suggestion);
      return;
    }
    if (visibleSuggestions.length && event.key === "Escape") {
      event.preventDefault();
      setDismissedSuggestionsFor(value);
      return;
    }
    if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && !event.currentTarget.value.trim()) {
      event.preventDefault();
      onCycleEffort(sessionId, event.key === "ArrowUp" ? 1 : -1);
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (!value.trim() && !attachments.length) return;
      event.preventDefault();
      submit(working ? "queue" : "submit");
      return;
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const input = event.currentTarget;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      update(`${input.value.slice(0, start)}\n${input.value.slice(end)}`);
      window.requestAnimationFrame(() => input.setSelectionRange(start + 1, start + 1));
      return;
    }
    if (!event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    onAddImages(sessionId, files);
  };

  return (
    <div
      className={`composer-wrap ${dragging ? "image-dragging" : ""} with-context`}
      onDragEnter={(event) => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); event.stopPropagation(); setDragging(true); } }}
      onDragOver={(event) => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; setDragging(true); } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={handleDrop}
    >
      <div className="composer-context">
        {threadId ? (
          <div className="composer-directory composer-directory-static" title={cwd}>
            <FolderOpen size={13} /><span className="composer-directory-path">{cwd}</span>
          </div>
        ) : (
          <button type="button" className="composer-directory editable" onClick={() => onChooseDirectory(sessionId)} title={`${cwd}\n发送第一条消息前可以切换目录`}><FolderOpen size={13} /><span className="composer-directory-path">{cwd}</span><ChevronDown size={12} /></button>
        )}
        {toolbar}
      </div>
      {attachments.length ? <div className="attachment-strip">{attachments.map((image, index) => <div className="attachment-preview" key={`${image.path}-${index}`}>
        <button type="button" className="attachment-preview-image" onClick={() => setPreviewSource(image.dataUrl)} title="点击放大"><img src={image.dataUrl} alt={image.name} /></button>
        <button type="button" className="attachment-remove" onClick={() => onRemoveImage(sessionId, index)} title="移除图片" aria-label="移除图片"><X size={12} /></button>
      </div>)}</div> : null}
      {pendingSteers.length ? <div className="queued-list pending-steer-list">
        <div className="queued-list-title"><CornerDownRight size={12} /><span>等待当前任务接收 {pendingSteers.length}</span></div>
        {pendingSteers.map((pending) => <div className="queued-item" key={pending.id}>
          <span>{pending.text || `${pending.images.length} 张图片`}</span>
        </div>)}
      </div> : null}
      {queuedMessages.length ? <div className="queued-list">
        <div className="queued-list-title"><Clock3 size={12} /><span>下一轮 {queuedMessages.length}</span></div>
        {queuedMessages.map((queued) => <div className="queued-item" key={queued.id}>
          <span>{queued.text || `${queued.images.length} 张图片`}</span>
          <button type="button" onClick={() => onRemoveQueuedMessage(sessionId, queued.id)} title="取消排队" aria-label="取消排队"><X size={12} /></button>
        </div>)}
      </div> : null}
      <form className="composer" onSubmit={(event: FormEvent) => { event.preventDefault(); submit("submit"); }}>
        <CommandSuggestions suggestions={visibleSuggestions} selectedIndex={selectedIndex} onSelect={acceptSuggestion} />
        <textarea
          value={value}
          onChange={(event) => update(event.target.value)}
          onPaste={(event) => {
            const clipboardFiles = Array.from(event.clipboardData.files);
            const files = clipboardFiles.length ? clipboardFiles : Array.from(event.clipboardData.items).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
            if (!files.length) return;
            event.preventDefault();
            onAddImages(sessionId, files);
          }}
          onKeyDown={handleKeyDown}
          onClick={() => {
            const query = value.match(/^\s*\/([^\s]*)$/);
            if (query) selectIndex(Math.min(selectedIndex, Math.max(0, suggestions.length - 1)));
          }}
          placeholder="描述你要完成的事情"
          aria-label="消息输入"
          rows={1}
        />
      </form>
      {dragging ? <div className="image-drop-overlay"><ImagePlus size={18} /><span>松开添加图片</span></div> : null}
      {previewSource ? <ImageLightbox source={previewSource} label="待发送图片预览" copyImage={copyImage} onClose={() => setPreviewSource(null)} /> : null}
    </div>
  );
}

export default memo(ComposerBase);
