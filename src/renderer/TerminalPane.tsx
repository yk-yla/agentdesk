import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { AgentBridge } from "../shared/protocol";
import type { TerminalEvent, TerminalSessionInfo } from "../shared/terminalProtocol";
import type { SessionState } from "./domain";
import { parseClaudeTerminalInput, parseClaudeTerminalSettings, type ClaudeTerminalSettings } from "./terminalSettings";
import { applyImeAnchorPlacement, resolveImeAnchorFromTerminal, resolveImeAnchorPlacement } from "./terminalImeAnchor";

const TERMINAL_FONT_FAMILY = "'Cascadia Mono', Consolas, 'Microsoft YaHei UI', monospace";
const TERMINAL_THEME = {
  background: "#101214",
  foreground: "#e7e9ec",
  cursor: "#e7e9ec",
  cursorAccent: "#101214",
  selectionBackground: "#3a4658",
  selectionForeground: "#f7fafc",
  selectionInactiveBackground: "#303947",
  scrollbarSliderBackground: "#66717fcc",
  scrollbarSliderHoverBackground: "#8d99a8ee",
  scrollbarSliderActiveBackground: "#aeb9c6f5",
  black: "#0c0c0c",
  red: "#c50f1f",
  green: "#13a10e",
  yellow: "#c19c00",
  blue: "#0037da",
  magenta: "#881798",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#767676",
  brightRed: "#e74856",
  brightGreen: "#16c60c",
  brightYellow: "#f9f1a5",
  brightBlue: "#3b78ff",
  brightMagenta: "#b4009e",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
};

interface TerminalPaneProps {
  session: SessionState;
  bridge: AgentBridge;
  isActive: boolean;
  onModeChange: (mode: "workbench" | "terminal") => void;
  onResume: () => void;
  onError: (message: string) => void;
  onSettings: (settings: ClaudeTerminalSettings) => void;
  onTerminalActivity: (working: boolean) => void;
}

export default function TerminalPane({ session, bridge, isActive, onModeChange, onResume, onError, onSettings, onTerminalActivity }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const infoRef = useRef<TerminalSessionInfo | null>(null);
  const generationRef = useRef<number | null>(null);
  const startingRef = useRef(false);
  const startBaselineGenerationRef = useRef<number | null>(null);
  const closeRequestedRef = useRef(false);
  // Do not retry a failed handoff while the parent rerenders during rollback.
  const startAttemptedRef = useRef(false);
  const mountedRef = useRef(false);
  const viewportYRef = useRef<number | null>(null);
  const onErrorRef = useRef(onError);
  const onModeChangeRef = useRef(onModeChange);
  const onResumeRef = useRef(onResume);
  const onSettingsRef = useRef(onSettings);
  const onTerminalActivityRef = useRef(onTerminalActivity);
  const terminalActivityTimerRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const ptyResizeTimerRef = useRef<number | null>(null);
  const ptyDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const terminalCommandActiveRef = useRef(false);
  const settingsBufferRef = useRef("");
  const inputSettingsBufferRef = useRef("");
  onErrorRef.current = onError;
  onModeChangeRef.current = onModeChange;
  onResumeRef.current = onResume;
  onSettingsRef.current = onSettings;
  onTerminalActivityRef.current = onTerminalActivity;
  const [info, setInfo] = useState<TerminalSessionInfo | null>(null);
  const [starting, setStarting] = useState(false);

  const clearTerminalActivity = useCallback(() => {
    if (terminalActivityTimerRef.current !== null) {
      window.clearTimeout(terminalActivityTimerRef.current);
      terminalActivityTimerRef.current = null;
    }
    terminalCommandActiveRef.current = false;
    onTerminalActivityRef.current(false);
  }, []);

  const markTerminalActivity = useCallback(() => {
    // Any PTY output reactivates the tab working indicator. The timer turns
    // it off after a quiet period with no further output.
    terminalCommandActiveRef.current = true;
    onTerminalActivityRef.current(true);
    if (terminalActivityTimerRef.current !== null) window.clearTimeout(terminalActivityTimerRef.current);
    terminalActivityTimerRef.current = window.setTimeout(() => {
      terminalActivityTimerRef.current = null;
      terminalCommandActiveRef.current = false;
      onTerminalActivityRef.current(false);
    }, 8_000);
  }, []);

  const markTerminalCommand = useCallback(() => {
    terminalCommandActiveRef.current = true;
    markTerminalActivity();
  }, [markTerminalActivity]);

  const write = useCallback((data: string) => {
    const current = infoRef.current;
    if (!current || current.status === "exited") return;
    if (data.includes("\r") || data.includes("\n")) markTerminalCommand();
    if (session.provider === "claude") {
      const previousInputBuffer = inputSettingsBufferRef.current;
      const parsed = parseClaudeTerminalInput(data, inputSettingsBufferRef.current);
      inputSettingsBufferRef.current = parsed.buffer;
      // Discard an older status line as soon as a new model menu/command is
      // opened. The next status line then becomes the only model candidate.
      if (parsed.buffer.startsWith("/model") && !previousInputBuffer.startsWith("/model")) settingsBufferRef.current = "";
      if (parsed.settings.model) onSettingsRef.current(parsed.settings);
    }
    void bridge.writeTerminalInput({ sessionId: session.id, generation: current.generation, data }).catch((error) => onErrorRef.current(error instanceof Error ? error.message : "终端输入失败。"));
  }, [bridge, markTerminalCommand, session.id, session.provider]);

  const resize = useCallback(() => {
    if (resizeFrameRef.current === null) {
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        const terminal = terminalRef.current;
        const fit = fitRef.current;
        if (!terminal || !fit) return;
        const activeBuffer = terminal.buffer.active;
        const viewportY = activeBuffer.viewportY;
        const atBottom = viewportY >= activeBuffer.baseY;
        try {
          fit.fit();
          if (!atBottom) {
            terminal.scrollToLine(viewportY);
            viewportYRef.current = viewportY;
          }
        } catch {
          // The container may be hidden while its pane is being switched.
        }
      });
    }
    if (ptyResizeTimerRef.current !== null) window.clearTimeout(ptyResizeTimerRef.current);
    ptyResizeTimerRef.current = window.setTimeout(() => {
      ptyResizeTimerRef.current = null;
      const terminal = terminalRef.current;
      if (!terminal) return;
      try {
        const current = infoRef.current;
        const dimensions = { cols: terminal.cols, rows: terminal.rows };
        const previousDimensions = ptyDimensionsRef.current;
        if (current && current.status !== "exited" && (previousDimensions?.cols !== dimensions.cols || previousDimensions.rows !== dimensions.rows)) {
          ptyDimensionsRef.current = dimensions;
          void bridge.resizeTerminal({ sessionId: session.id, generation: current.generation, ...dimensions }).catch(() => undefined);
        }
      } catch {
        // The PTY may have exited during a pending layout update.
      }
    }, 260);
  }, [bridge, session.id]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 17,
      scrollback: 5_000,
      overviewRuler: { width: 0 },
      rightClickSelectsWord: true,
      scrollOnUserInput: true,
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    // Intercept DECSCUSR (CSI Ps SP q) to keep the cursor as a thin bar
    // regardless of what the CLI requests. This prevents Claude/Codex from
    // switching to a fat block cursor.
    const decscusrDisposable = terminal.parser.registerCsiHandler(
      { intermediates: " ", final: "q" },
      () => true,
    );
    // A new xterm instance always belongs to a new PTY lifecycle. Do not
    // suppress its first resize just because the previous instance had the
    // same dimensions.
    ptyDimensionsRef.current = null;
    let compositionTimer: number | null = null;
    let compositionAnchor: { column: number; row: number } | null = null;
    // Observe DECSET/DECRST 25 (show/hide cursor). Returning false lets xterm
    // apply the sequence as usual; this only records the state, because xterm
    // exposes no public API for it and the rendered cursor element depends on
    // render timing and focus.
    let appCursorHidden = false;
    const cursorVisibilityDisposables = [
      terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
        if (params.includes(25)) appCursorHidden = false;
        return false;
      }),
      terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
        if (params.includes(25)) appCursorHidden = true;
        return false;
      }),
    ];
    const resolveAnchor = () => {
      const active = terminal.buffer.active;
      return resolveImeAnchorFromTerminal({
        columns: terminal.cols,
        rows: terminal.rows,
        cursorColumn: active.cursorX,
        cursorRow: active.cursorY,
        baseRow: active.baseY,
        viewportRow: active.viewportY,
        // Ink TUIs (Claude Code) hide the cursor and draw their own caret,
        // leaving the real cursor at the end of the row they repainted last.
        cursorHidden: appCursorHidden,
        getLine: (absoluteRow) => active.getLine(absoluteRow),
      });
    };
    const applyCompositionPlacement = () => {
      const composition = terminal.element?.querySelector<HTMLElement>(".composition-view");
      if (!composition || !composition.classList.contains("active")) {
        compositionAnchor = null;
        return;
      }
      // Freeze the anchor for one composition. Re-resolving on every redraw
      // would move the pinyin whenever the CLI repaints another row.
      if (!compositionAnchor) {
        const anchor = resolveAnchor();
        compositionAnchor = { column: anchor.column, row: anchor.row };
      }
      // The xterm element reserves space for its scrollbar. Use the screen
      // bounds, otherwise the last columns are treated as usable even though
      // they already sit inside the scrollbar/blank area.
      const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
      const bounds = (screen || host).getBoundingClientRect();
      const cellWidth = terminal.cols > 0 ? bounds.width / terminal.cols : 0;
      const cellHeight = terminal.rows > 0 ? bounds.height / terminal.rows : 0;
      const textarea = terminal.textarea;
      const placement = resolveImeAnchorPlacement({
        cellLeft: compositionAnchor.column * cellWidth,
        cellTop: compositionAnchor.row * cellHeight,
        compositionWidth: Math.max(composition.scrollWidth, composition.getBoundingClientRect().width),
        compositionTextLength: composition.textContent?.length ?? 0,
        cellWidth,
        screenWidth: bounds.width,
        screenHeight: bounds.height,
        cellHeight,
        textareaWidth: textarea ? Number.parseFloat(textarea.style.width) || 1 : 1,
      });
      applyImeAnchorPlacement(placement, composition.style, textarea?.style ?? null);
    };
    // xterm registers its own onRender -> updateCompositionElements during
    // construction, so every redraw synchronously moves the composition back to
    // the real cursor cell, and it repeats that once more via setTimeout(0).
    // Correct synchronously and again after that timeout. A
    // requestAnimationFrame here gets throttled while the window is hidden,
    // which lets xterm's position win.
    const placeComposition = () => {
      applyCompositionPlacement();
      // Always reschedule instead of skipping when one is pending: xterm may
      // have queued a later setTimeout in this same event, and skipping would
      // let it move the composition back to the real cursor cell.
      if (compositionTimer !== null) window.clearTimeout(compositionTimer);
      compositionTimer = window.setTimeout(() => {
        compositionTimer = null;
        applyCompositionPlacement();
      }, 0);
    };
    const renderDisposable = terminal.onRender(placeComposition);
    const compositionEvents = ["compositionstart", "compositionupdate", "compositionend", "input"] as const;
    for (const eventName of compositionEvents) terminal.textarea?.addEventListener(eventName, placeComposition);
    const handleCopy = (event: ClipboardEvent) => {
      if (!terminal.hasSelection()) return;
      const text = terminal.getSelection();
      event.preventDefault();
      event.stopPropagation();
      if (event.clipboardData) event.clipboardData.setData("text/plain", text);
      void bridge.writeClipboardText(text).catch((error) => onErrorRef.current(error instanceof Error ? error.message : "复制终端文字失败。"));
    };
    const handlePaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const text = event.clipboardData?.getData("text/plain") || "";
      if (text) {
        terminal.paste(text);
        return;
      }
      // Electron can occasionally omit clipboardData for a native paste. Use
      // the controlled bridge only as a fallback, so one paste event still
      // produces one terminal write.
      void bridge.readClipboardText().then((clipboardText) => {
        if (clipboardText && terminalRef.current === terminal) terminal.paste(clipboardText);
      }).catch(() => undefined);
    };
    const handleCustomKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const commandModifier = event.ctrlKey || event.metaKey;
      if (commandModifier && !event.altKey && (key === "c" || key === "insert")) {
        if (terminal.hasSelection()) {
          event.preventDefault();
          event.stopPropagation();
          void bridge.writeClipboardText(terminal.getSelection()).catch((error) => onErrorRef.current(error instanceof Error ? error.message : "复制终端文字失败。"));
          return false;
        }
        // Without a selection Ctrl+C keeps normal terminal semantics and
        // reaches the PTY as an interrupt signal.
        return true;
      }
      if ((key === "v" && commandModifier || key === "insert" && event.shiftKey) && !event.altKey) {
        // Let the browser emit one native paste event. Returning false keeps
        // the shortcut out of the PTY while handlePaste performs one write.
        return false;
      }
      if (key === "enter" && commandModifier && !event.altKey) {
        // A terminal cannot encode Ctrl+Enter: xterm sends the same CR as a
        // plain Enter, so the CLI cannot tell them apart and would submit.
        // Translate it into the ESC+CR that Claude/Codex already accept as
        // "insert a newline", which keeps plain Enter as submit.
        event.preventDefault();
        event.stopPropagation();
        write("\x1b\r");
        return false;
      }
      return true;
    };
    // Capture text paste before the CLI can interpret Ctrl+V as image input.
    host.addEventListener("copy", handleCopy, true);
    host.addEventListener("paste", handlePaste, true);
    terminal.attachCustomKeyEventHandler(handleCustomKey);
    // Codex/Claude TUIs may enable mouse-reporting mode, which makes xterm
    // forward wheel events to the CLI instead of scrolling its own scrollback.
    // Keep the wheel dedicated to terminal history so the embedded view can
    // always move above the current screen.
    terminal.attachCustomWheelEventHandler((event) => {
      if (event.deltaY === 0) return true;
      if (terminal.modes.mouseTrackingMode !== "none" && !event.shiftKey) return true;
      const magnitude = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? Math.abs(event.deltaY)
        : Math.max(1, Math.round(Math.abs(event.deltaY) / 20));
      terminal.scrollLines(event.deltaY > 0 ? magnitude : -magnitude);
      return false;
    });
    const scrollDisposable = terminal.onScroll((viewportY) => {
      viewportYRef.current = viewportY;
    });
    terminal.focus();
    const focusFrame = requestAnimationFrame(() => {
      if (terminalRef.current === terminal) terminal.focus();
    });
    const dataDisposable = terminal.onData(write);
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    requestAnimationFrame(resize);
    return () => {
      cancelAnimationFrame(focusFrame);
      if (ptyResizeTimerRef.current !== null) {
        window.clearTimeout(ptyResizeTimerRef.current);
        ptyResizeTimerRef.current = null;
      }
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
      if (compositionTimer !== null) window.clearTimeout(compositionTimer);
      renderDisposable.dispose();
      for (const eventName of compositionEvents) terminal.textarea?.removeEventListener(eventName, placeComposition);
      host.removeEventListener("copy", handleCopy, true);
      host.removeEventListener("paste", handlePaste, true);
      clearTerminalActivity();
      scrollDisposable.dispose();
      resizeObserver.disconnect();
      dataDisposable.dispose();
      decscusrDisposable.dispose();
      for (const disposable of cursorVisibilityDisposables) disposable.dispose();
      const current = infoRef.current;
      if (current && current.status !== "exited") {
        closeRequestedRef.current = true;
        void bridge.closeTerminal({ sessionId: session.id, generation: current.generation }).catch(() => undefined);
      }
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [bridge, clearTerminalActivity, resize, session.id, write]);

  useEffect(() => {
    if (!isActive) return undefined;
    const frame = requestAnimationFrame(() => {
      terminalRef.current?.focus();
      resize();
    });
    return () => cancelAnimationFrame(frame);
  }, [isActive, resize]);

  useEffect(() => {
    const restoreViewport = () => {
      const terminal = terminalRef.current;
      const viewportY = viewportYRef.current;
      if (!terminal || viewportY === null || terminal.buffer.active.viewportY >= terminal.buffer.active.baseY) return;
      terminal.scrollToLine(viewportY);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      requestAnimationFrame(() => requestAnimationFrame(restoreViewport));
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => bridge.onTerminalEvent((event: TerminalEvent) => {
    if (event.sessionId !== session.id || event.provider !== session.provider) return;
    const knownGeneration = generationRef.current;
    if (knownGeneration !== null && event.generation < knownGeneration) return;
    if (startingRef.current && startBaselineGenerationRef.current !== null && event.generation <= startBaselineGenerationRef.current) return;
    if (event.type === "started" || event.type === "ready") {
      if (!event.info) return;
      if (knownGeneration !== null && event.info.generation < knownGeneration) return;
      generationRef.current = event.info.generation;
      infoRef.current = event.info;
      if (!knownGeneration || event.info.generation !== knownGeneration) ptyDimensionsRef.current = null;
      setInfo(event.info);
      if (event.type === "ready") {
        clearTerminalActivity();
        startingRef.current = false;
        startBaselineGenerationRef.current = null;
        setStarting(false);
      }
      requestAnimationFrame(resize);
    } else if (event.type === "output" && event.data && generationRef.current === event.generation) {
      markTerminalActivity();
      if (session.provider === "claude") {
        const parsed = parseClaudeTerminalSettings(event.data, settingsBufferRef.current);
        settingsBufferRef.current = parsed.buffer;
        if (parsed.settings.model || parsed.settings.effort) onSettingsRef.current(parsed.settings);
      }
      const terminal = terminalRef.current;
      if (!terminal) return;
      const activeBuffer = terminal.buffer.active;
      const viewportY = activeBuffer.viewportY;
      const atBottom = viewportY >= activeBuffer.baseY;
      terminal.write(event.data, () => {
        if (!atBottom) terminal.scrollToLine(viewportY);
        viewportYRef.current = atBottom ? terminal.buffer.active.viewportY : viewportY;
      });
    } else if (event.type === "exited" && (generationRef.current === null || generationRef.current === event.generation)) {
      clearTerminalActivity();
      infoRef.current = event.info || (infoRef.current ? { ...infoRef.current, status: "exited" } : null);
      setInfo(infoRef.current);
      startingRef.current = false;
      setStarting(false);
      if (session.provider === "claude") {
        onErrorRef.current(`Claude Code 终端已退出${typeof event.exitCode === "number" ? `（退出码 ${event.exitCode}）` : ""}。`);
      } else {
        const exitCode = typeof event.exitCode === "number" ? `（退出码 ${event.exitCode}）` : "";
        onErrorRef.current(`终端进程已退出${exitCode}，已返回图形界面。`);
        onModeChangeRef.current("workbench");
      }
    } else if (event.type === "error") {
      clearTerminalActivity();
      startingRef.current = false;
      startBaselineGenerationRef.current = null;
      setStarting(false);
      onErrorRef.current(event.message || "终端启动失败。");
      if (session.provider !== "claude") onModeChangeRef.current("workbench");
    }
  }), [bridge, clearTerminalActivity, markTerminalActivity, resize, session.id, session.provider]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (!mountedRef.current && startingRef.current) {
          closeRequestedRef.current = true;
          void bridge.closeTerminal({ sessionId: session.id }).catch(() => undefined);
        }
      });
    };
  }, [bridge, session.id]);

  const start = useCallback(async () => {
    if (startAttemptedRef.current || startingRef.current || (infoRef.current && infoRef.current.status !== "exited")) return;
    startAttemptedRef.current = true;
    settingsBufferRef.current = "";
    inputSettingsBufferRef.current = "";
    startingRef.current = true;
    startBaselineGenerationRef.current = generationRef.current;
    setStarting(true);
    onResumeRef.current();
    try {
      const request = {
        provider: session.provider,
        sessionId: session.id,
        cwd: session.cwd,
        ...(session.threadId ? { nativeSessionId: session.threadId, resume: true } : {}),
      };
      const next = await bridge.startTerminalSession({
        ...request,
      });
      generationRef.current = next.generation;
      if (closeRequestedRef.current) {
        closeRequestedRef.current = false;
        await bridge.closeTerminal({ sessionId: session.id, generation: next.generation }).catch(() => undefined);
        startingRef.current = false;
        startBaselineGenerationRef.current = null;
        setStarting(false);
        return;
      }
      infoRef.current = next;
      setInfo(next);
    } catch (error) {
      clearTerminalActivity();
      startAttemptedRef.current = false;
      startingRef.current = false;
      startBaselineGenerationRef.current = null;
      setStarting(false);
      onErrorRef.current(error instanceof Error ? error.message : "终端启动失败。");
      if (session.provider !== "claude") onModeChangeRef.current("workbench");
    }
  }, [bridge, clearTerminalActivity, session.cwd, session.id, session.provider, session.threadId]);

  useEffect(() => {
    if (session.presentationMode !== "terminal" || session.terminalSuspended) return;
    void start();
  }, [session.presentationMode, session.terminalSuspended, start]);

  return (
    <section className="terminal-pane" aria-label={session.provider === "claude" ? "Claude Code 黑窗口" : "Codex 黑窗口"}>
      {session.provider !== "claude" && <button
        type="button"
        className="presentation-toggle terminal-presentation-toggle"
        onClick={() => onModeChange("workbench")}
        disabled={Boolean(session.terminalSuspended)}
        title={session.terminalSuspended ? "正在准备终端" : "切换到图形界面"}
        aria-label="切换到图形界面"
      ><ArrowLeftRight size={16} /></button>}
      <div className="terminal-host">
        <div ref={hostRef} className="terminal-host-inner" onClick={() => terminalRef.current?.focus()} />
      </div>
      {session.terminalSuspended || starting ? <div className="terminal-status" role="status">正在启动终端…</div> : null}
      {session.errorText ? <div className="terminal-error" role="alert">{session.errorText}</div> : null}
    </section>
  );
}
