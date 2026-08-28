import type { Message } from "./domain";

export interface ConversationSearchMatch {
  messageId: string;
  messageIndex: number;
  occurrence: number;
}

export function normalizedConversationSearchTerm(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function findConversationSearchMatches(messages: Pick<Message, "id" | "text">[], query: string): ConversationSearchMatch[] {
  const term = normalizedConversationSearchTerm(query);
  if (!term) return [];
  const matches: ConversationSearchMatch[] = [];
  messages.forEach((message, messageIndex) => {
    const text = message.text.toLocaleLowerCase();
    let fromIndex = 0;
    let occurrence = 0;
    while (fromIndex <= text.length - term.length) {
      const index = text.indexOf(term, fromIndex);
      if (index < 0) break;
      matches.push({ messageId: message.id, messageIndex, occurrence });
      occurrence += 1;
      fromIndex = index + term.length;
    }
  });
  return matches;
}
