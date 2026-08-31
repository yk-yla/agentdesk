import { useCallback, useEffect, useRef, type FocusEventHandler, type MouseEventHandler } from "react";

interface AutoDismissInteractionProps {
  onMouseEnter: MouseEventHandler<HTMLElement>;
  onMouseLeave: MouseEventHandler<HTMLElement>;
  onFocusCapture: FocusEventHandler<HTMLElement>;
  onBlurCapture: FocusEventHandler<HTMLElement>;
}

export function useAutoDismissNotice(key: string | null, durationMs: number | null, onDismiss: () => void): AutoDismissInteractionProps {
  const callbackRef = useRef(onDismiss);
  const timerRef = useRef<number | undefined>(undefined);
  const startedAtRef = useRef(0);
  const remainingMsRef = useRef(0);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);
  callbackRef.current = onDismiss;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const schedule = useCallback(() => {
    clearTimer();
    if (!key || durationMs === null || hoveredRef.current || focusedRef.current) return;
    startedAtRef.current = Date.now();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      callbackRef.current();
    }, Math.max(0, remainingMsRef.current));
  }, [clearTimer, durationMs, key]);

  const pause = useCallback(() => {
    if (timerRef.current === undefined) return;
    remainingMsRef.current = Math.max(0, remainingMsRef.current - (Date.now() - startedAtRef.current));
    clearTimer();
  }, [clearTimer]);

  useEffect(() => {
    remainingMsRef.current = durationMs || 0;
    schedule();
    return clearTimer;
  }, [clearTimer, durationMs, key, schedule]);

  return {
    onMouseEnter: () => { hoveredRef.current = true; pause(); },
    onMouseLeave: () => { hoveredRef.current = false; schedule(); },
    onFocusCapture: () => { focusedRef.current = true; pause(); },
    onBlurCapture: (event) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      focusedRef.current = false;
      schedule();
    },
  };
}
