import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { AgentBridge } from "../shared/protocol";
import type { TerminalEvent, TerminalSessionInfo } from "../shared/terminalProtocol";
import type { SessionState } from "./domain";
import { parseClaudeTerminalInput, parseClaudeTerminalSettings, type ClaudeTerminalSettings } from "./terminalSettings";

interface TerminalPaneProps {
  session: SessionState;
  bridge: AgentBridge;
  isActive: boolean;
  onModeChange: (mode: "workbench" | "terminal") => void;
  onResume: () => void;
  onError: (message: string) => void;
  onSettings: (settings: ClaudeTerminalSettings) => void;
}

export default function TerminalPane({ session, bridge, isActive, onModeChange, onResume, onError, onSettings }: TerminalPaneProps) {
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
  const settingsBufferRef = useRef("");
  const inputSettingsBufferRef = useRef("");
  onErrorRef.current = onError;
  onModeChangeRef.current = onModeChange;
  onResumeRef.current = onResume;
  onSettingsRef.current = onSettings;
  const [info, setInfo] = useState<TerminalSessionInfo | null>(null);
  const [starting, setStarting] = useState(false);

  const write = useCallback((data: string) => {
    const current = infoRef.current;
    if (!current || current.status === "exited") return;
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
  }, [bridge, session.id, session.provider]);

  const resize = useCallback(() => {
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
      const current = infoRef.current;
      if (current && current.status !== "exited") {
        void bridge.resizeTerminal({ sessionId: session.id, generation: current.generation, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
      }
    } catch {
      // The container may be hidden while its pane is being switched.
    }
  }, [bridge, session.id]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: "Consolas, 'Cascadia Mono', monospace",
      fontSize: 17,
      scrollback: 5_000,
      overviewRuler: { width: 0 },
      scrollOnUserInput: true,
      theme: { background: "#101214", foreground: "#e7e9ec", cursor: "#e7e9ec", selectionBackground: "#3a4658", scrollbarSliderBackground: "transparent", scrollbarSliderHoverBackground: "transparent", scrollbarSliderActiveBackground: "transparent" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") || "";
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      terminal.paste(text);
    };
    const handleCustomKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "v" || (!event.ctrlKey && !event.metaKey) || event.altKey) return true;
      void bridge.readClipboardText().then((text) => {
        if (text && terminalRef.current === terminal) terminal.paste(text);
      }).catch(() => undefined);
      return false;
    };
    // Capture text paste before the CLI can interpret Ctrl+V as image input.
    host.addEventListener("paste", handlePaste, true);
    terminal.attachCustomKeyEventHandler(handleCustomKey);
    // Codex/Claude TUIs may enable mouse-reporting mode, which makes xterm
    // forward wheel events to the CLI instead of scrolling its own scrollback.
    // Keep the wheel dedicated to terminal history so the embedded view can
    // always move above the current screen.
    terminal.attachCustomWheelEventHandler((event) => {
      if (event.deltaY === 0) return true;
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
      host.removeEventListener("paste", handlePaste, true);
      scrollDisposable.dispose();
      resizeObserver.disconnect();
      dataDisposable.dispose();
      const current = infoRef.current;
      if (current && current.status !== "exited") {
        closeRequestedRef.current = true;
        void bridge.closeTerminal({ sessionId: session.id, generation: current.generation }).catch(() => undefined);
      }
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [bridge, resize, session.id, write]);

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
      setInfo(event.info);
      if (event.type === "ready") {
        startingRef.current = false;
        startBaselineGenerationRef.current = null;
        setStarting(false);
      }
      requestAnimationFrame(resize);
    } else if (event.type === "output" && event.data && generationRef.current === event.generation) {
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
      startingRef.current = false;
      startBaselineGenerationRef.current = null;
      setStarting(false);
      onErrorRef.current(event.message || "终端启动失败。");
      if (session.provider !== "claude") onModeChangeRef.current("workbench");
    }
  }), [bridge, resize, session.id, session.provider]);

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
      startAttemptedRef.current = false;
      startingRef.current = false;
      startBaselineGenerationRef.current = null;
      setStarting(false);
      onErrorRef.current(error instanceof Error ? error.message : "终端启动失败。");
      if (session.provider !== "claude") onModeChangeRef.current("workbench");
    }
  }, [bridge, session.cwd, session.id, session.provider, session.threadId]);

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
      <div ref={hostRef} className="terminal-host" onClick={() => terminalRef.current?.focus()} />
      {session.terminalSuspended || starting ? <div className="terminal-status" role="status">正在启动终端…</div> : null}
      {session.errorText ? <div className="terminal-error" role="alert">{session.errorText}</div> : null}
    </section>
  );
}
