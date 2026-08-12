export type QuestionNavigationDirection = "previous" | "next";

export const QUESTION_ANCHOR_SELECTOR = "[data-user-message-anchor]";
export const QUESTION_SCROLL_TOP_PADDING = 12;

interface QuestionNavigationKey {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function questionNavigationDirection(event: QuestionNavigationKey): QuestionNavigationDirection | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === "PageUp") return "previous";
  if (event.key === "PageDown") return "next";
  return null;
}

export function findQuestionAnchorIndex(
  anchorScrollTops: number[],
  currentScrollTop: number,
  direction: QuestionNavigationDirection,
  tolerance = 2,
) {
  if (direction === "previous") {
    for (let index = anchorScrollTops.length - 1; index >= 0; index -= 1) {
      if (anchorScrollTops[index] < currentScrollTop - tolerance) return index;
    }
    return -1;
  }
  return anchorScrollTops.findIndex((top) => top > currentScrollTop + tolerance);
}
