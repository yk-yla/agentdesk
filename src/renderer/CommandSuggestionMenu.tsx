import { Command, Sparkles, Terminal } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import type { CommandSuggestion } from "./commandSuggestions";

interface Props {
  suggestions: CommandSuggestion[];
  selectedIndex: number;
  onSelect: (suggestion: CommandSuggestion) => void;
}

function CommandSuggestions({ suggestions, selectedIndex, onSelect }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const selected = menuRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, suggestions]);

  if (!suggestions.length) return null;
  return (
    <div ref={menuRef} className="command-suggestions" role="listbox" aria-label="命令和 Skill">
      {suggestions.map((suggestion, index) => {
        const isSkill = suggestion.kind === "skill";
        return (
          <button
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            className={`command-suggestion ${index === selectedIndex ? "selected" : ""}`}
            key={`${suggestion.kind}:${suggestion.name}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(suggestion)}
          >
            <span className="command-suggestion-icon">{isSkill ? <Sparkles size={14} /> : suggestion.name === "clear" ? <Terminal size={14} /> : <Command size={14} />}</span>
            <span className="command-suggestion-copy">
              <strong>/{suggestion.name}</strong>
              <span>{suggestion.description}</span>
            </span>
            {isSkill ? <small>{suggestion.scope}</small> : null}
          </button>
        );
      })}
    </div>
  );
}

export default memo(CommandSuggestions);
