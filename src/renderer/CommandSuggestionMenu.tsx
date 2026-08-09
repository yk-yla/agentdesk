import { Command, Sparkles, Terminal } from "lucide-react";
import { memo } from "react";
import type { CommandSuggestion } from "./commandSuggestions";

interface Props {
  suggestions: CommandSuggestion[];
  selectedIndex: number;
  onSelect: (suggestion: CommandSuggestion) => void;
}

function CommandSuggestions({ suggestions, selectedIndex, onSelect }: Props) {
  if (!suggestions.length) return null;
  return (
    <div className="command-suggestions" role="listbox" aria-label="命令和 Skill">
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
