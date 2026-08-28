import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useEffect, type KeyboardEvent, type RefObject } from "react";

export interface ConversationSearchProps {
  open: boolean;
  query: string;
  matchCount: number;
  activeMatchIndex: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onOpen: () => void;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onPrevious: () => void;
  onNext: () => void;
}

function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>, props: ConversationSearchProps) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    props.onClose();
    return;
  }
  if (event.key !== "Enter") return;
  event.preventDefault();
  event.stopPropagation();
  if (event.shiftKey) props.onPrevious();
  else props.onNext();
}

export default function ConversationSearch(props: ConversationSearchProps) {
  useEffect(() => {
    if (props.open) props.inputRef.current?.focus();
  }, [props.inputRef, props.open]);

  if (!props.open) {
    return <button
      type="button"
      className="conversation-search-toggle"
      onClick={props.onOpen}
      title="搜索当前会话"
      aria-label="搜索当前会话"
    ><Search size={15} /></button>;
  }

  const countLabel = props.matchCount ? `${props.activeMatchIndex + 1}/${props.matchCount}` : "0/0";
  const disabled = props.matchCount === 0;
  return <div className="conversation-search" role="search" aria-label="搜索当前会话">
    <div className="conversation-search-row">
      <Search className="conversation-search-icon" size={16} aria-hidden="true" />
      <input
        ref={props.inputRef}
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={(event) => handleSearchKeyDown(event, props)}
        placeholder="搜索当前会话"
        aria-label="搜索当前会话"
        spellCheck={false}
      />
      <span className={`conversation-search-count${disabled ? " empty" : ""}`} aria-live="polite">{countLabel}</span>
      <button type="button" className="conversation-search-action" onClick={props.onPrevious} disabled={disabled} title="上一个匹配" aria-label="上一个匹配"><ChevronUp size={15} /></button>
      <button type="button" className="conversation-search-action" onClick={props.onNext} disabled={disabled} title="下一个匹配" aria-label="下一个匹配"><ChevronDown size={15} /></button>
      <button type="button" className="conversation-search-action conversation-search-close" onClick={props.onClose} title="关闭搜索" aria-label="关闭搜索"><X size={16} /></button>
    </div>
    <div className="conversation-search-hint"><kbd>Ctrl+F</kbd>打开 · <kbd>Enter</kbd>下一个 · <kbd>Esc</kbd>关闭</div>
  </div>;
}
