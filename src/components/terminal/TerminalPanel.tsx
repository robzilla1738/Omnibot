import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Copy, Expand, Keyboard, Loader2, Minimize2, Radio, Search, Square, TerminalSquare, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { getOmniSnapshot, listTerminals, readTerminal, resizeTerminal, startTerminal, stopOmniChat, stopTerminal, writeTerminal, type TerminalSessionInfo } from "../../lib/omni-bridge";
import type { BotProfile, ChatThread } from "../../lib/types";

type SavedScreen = { text: string; offset: number; cols: number; rows: number };
const isLive = (session: TerminalSessionInfo) => session.status === "running" || session.status === "queued";
const supportsControl = (bot?: BotProfile) => bot && !bot.archived && (bot.cliDriver === "claude" || bot.cliDriver === "custom");
const OUTPUT_POLL_MIN_MS = 80;
const OUTPUT_POLL_MAX_MS = 1000;
const OUTPUT_POLL_ERROR_MS = 2000;
const READ_CHUNK_BYTES = 65536;
const MAX_QUEUED_INPUT_BYTES = 65536;

export function TerminalPanel({ open, chat, bots, workflowActive, onClose }: {
  open: boolean; chat: ChatThread; bots: BotProfile[]; workflowActive: boolean; onClose: () => void;
}) {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(460);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"interactive" | "output">("interactive");
  const [loadedChat, setLoadedChat] = useState<string | null>(null);
  const attemptedOpen = useRef(false);
  const opening = useRef(new Set<string>());
  const context = useRef({ chatId: chat.id, open, view });
  context.current = { chatId: chat.id, open, view };
  const [botId, setBotId] = useState("");
  const screens = useRef(new Map<string, SavedScreen>());
  const actionChat = useRef(chat.id);
  actionChat.current = chat.id;
  const participants = bots.filter(bot => !bot.archived && chat.participantBotIds.includes(bot.id));
  const chatSessions = sessions.filter(session => session.chatId === chat.id);
  const visibleSessions = chatSessions.filter(session => session.mode === view);
  const selected = visibleSessions.find(session => session.id === selectedId) ?? visibleSessions[visibleSessions.length - 1];
  const selectedBot = bots.find(bot => bot.id === (selected?.botId ?? botId)) ?? participants[0];
  const interactive = chatSessions.find(session => session.mode === "interactive" && isLive(session));

  useEffect(() => { attemptedOpen.current = false; setView("interactive"); setBusy(false); setLoadedChat(null); setSelectedId(null); setFollow(true); setError(""); setBotId(""); }, [chat.id]);
  useEffect(() => { if (!open) attemptedOpen.current = false; else { setView("interactive"); setSelectedId(null); } }, [open]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await listTerminals(chat.id);
        if (disposed) return;
        setSessions(next); setLoadedChat(chat.id);
        const candidates = next.filter(session => session.mode === view);
        if (follow) setSelectedId((candidates.filter(isLive).pop() ?? candidates[candidates.length - 1])?.id ?? null);
      } catch (error) { if (!disposed) setError(String(error)); }
      finally { if (!disposed) timer = setTimeout(refresh, 750); }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [open, chat.id, follow, view]);

  const takeControl = async () => {
    if (!supportsControl(selectedBot) || opening.current.has(chat.id)) return;
    const chatId = chat.id;
    const stillViewing = () => context.current.open && context.current.chatId === chatId && context.current.view === "interactive";
    opening.current.add(chatId);
    setBusy(true); setError("");
    try {
      // Read authoritative sessions before stopping anything: reopening must never
      // stop the interactive process we are about to reconnect to.
      const existing = await listTerminals(chatId);
      if (!stillViewing()) return;
      const running = existing.find(session => session.mode === "interactive" && isLive(session));
      if (running) { setSessions(existing); setSelectedId(running.id); return; }
      const snapshot = await getOmniSnapshot();
      if (!stillViewing()) return;
      if (snapshot.activeWorkflowChatIds.includes(chatId)) {
        await stopOmniChat(chatId);
        const deadline = Date.now() + 15_000;
        let wait = 250;
        while ((await getOmniSnapshot()).activeWorkflowChatIds.includes(chatId)) {
          if (!stillViewing()) return;
          if (Date.now() > deadline) throw new Error("The workflow is still stopping. Wait for it to finish, then retry.");
          await new Promise(resolve => setTimeout(resolve, wait));
          wait = Math.min(1000, wait * 1.5);
        }
      }
      if (!stillViewing()) return;
      const next = await startTerminal(chatId, selectedBot!.id);
      if (actionChat.current !== chatId) return;
      setSessions(current => [...current.filter(session => session.id !== next.id), next]); setSelectedId(next.id); setFollow(true);
    } catch (error) { if (actionChat.current === chatId) setError(String(error)); }
    finally { opening.current.delete(chatId); if (actionChat.current === chatId) setBusy(false); }
  };
  // Attempt once per opening; failures and natural exits require an explicit retry.
  useEffect(() => {
    if (!open || view !== "interactive" || loadedChat !== chat.id || attemptedOpen.current) return;
    attemptedOpen.current = true;
    void takeControl();
  });
  const endControl = async () => {
    if (!interactive || busy) return;
    setBusy(true); setError("");
    try { await stopTerminal(interactive.id); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  const reportError = useCallback((error: string) => setError(error), []);

  return <aside aria-label="Bot terminal" hidden={!open} className={`terminal-panel ${expanded ? "terminal-expanded" : ""}`} style={{ width: expanded ? undefined : width }}>
    {!expanded && <div role="separator" aria-label="Resize terminal" aria-orientation="vertical" tabIndex={0} aria-valuenow={width} aria-valuemin={340} aria-valuemax={760}
      className="terminal-resize" onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setWidth(value => Math.min(760, Math.max(340, value + (event.key === "ArrowLeft" ? 24 : -24)))); } }}
      onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setWidth(Math.min(760, Math.max(340, event.currentTarget.parentElement!.getBoundingClientRect().right - event.clientX))); }}
      onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />}
    <header className="terminal-heading">
      <div className="terminal-heading-icon"><TerminalSquare size={17} /></div>
      <div className="min-w-0 flex-1"><h2>Terminal</h2><p>{interactive ? "You’re in control" : "Your bot’s command line"}</p></div>
      <button className={`terminal-icon ${follow ? "is-on" : ""}`} aria-label="Follow active bot" aria-pressed={follow} title="Follow active bot" onClick={() => setFollow(value => !value)}><Radio size={16} /></button>
      <button className="terminal-icon" aria-label={expanded ? "Restore terminal size" : "Expand terminal"} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={16} /> : <Expand size={16} />}</button>
      <button className="terminal-icon" aria-label="Hide terminal" title="Hide terminal · process keeps running" onClick={onClose}><X size={17} /></button>
    </header>
    <div className="terminal-view-switch" role="group" aria-label="Terminal view">
      <button aria-pressed={view === "interactive"} onClick={() => { setView("interactive"); setSelectedId(null); }}>Interactive CLI</button>
      <button aria-pressed={view === "output"} onClick={() => { setView("output"); setSelectedId(null); }}>Run logs</button>
    </div>
    {visibleSessions.length > 0 && <div className="terminal-tabs" role="tablist" aria-label="Bot processes">
      {visibleSessions.map((session, index) => <button key={session.id} role="tab" aria-selected={selected?.id === session.id} title={`${session.botName} · ${session.status === "queued" ? "Waiting for an available slot" : session.status}${session.exitCode !== null ? ` · exit ${session.exitCode}` : ""}`} className="terminal-tab" onClick={() => { setSelectedId(session.id); setFollow(false); }}>
        <span className={`terminal-dot ${isLive(session) ? "live" : session.status === "error" ? "failed" : ""}`} />
        <span>{session.botName}</span><span className="terminal-tab-number">{session.mode === "interactive" ? <Keyboard size={12} /> : String(index + 1).padStart(2, "0")}</span>
      </button>)}
    </div>}
    {error && <div className="terminal-error" role="alert"><span>{error}</span><button aria-label="Dismiss terminal error" onClick={() => setError("")}><X size={14} /></button></div>}
    {selected ? <>
      <div className="terminal-context"><span className="terminal-mode">{selected.mode === "interactive" ? "INTERACTIVE CLI" : "RUN LOG"}</span><span className="truncate" title={selected.cwd}>{selected.cwd ? (/\/bots\/[^/]+\/home$/.test(selected.cwd) ? "Bot home" : selected.cwd) : "Preparing working folder…"}</span></div>
      <TerminalScreen key={selected.id} session={selected} open={open} screens={screens.current} onError={reportError} />
      {selected.error && <div className="terminal-error" role="status">{selected.error}</div>}
    </> : <div className="terminal-empty">
      <div className="terminal-empty-art"><span /><TerminalSquare size={33} strokeWidth={1.2} /><span /></div>
      <h3>{busy ? `Opening ${selectedBot?.name ?? "your bot"}…` : view === "output" ? "Run logs" : "Your bot’s command line"}</h3>
      <p>{busy ? "Preparing the interactive CLI. Any automated run will stop first." : view === "output" ? "Automated process output appears here when a bot runs." : supportsControl(selectedBot) ? "Connect directly to your bot’s interactive CLI." : "Interactive CLI is available for Claude Code and custom commands. This bot’s output is available in Run logs."}</p>
      <label className="terminal-bot-select"><select aria-label="Terminal bot" value={selectedBot?.id ?? ""} onChange={event => { setBotId(event.target.value); attemptedOpen.current = false; }}>{participants.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
      <div className="terminal-empty-hint">{busy ? <Loader2 className="animate-spin" size={15} /> : <Keyboard size={15} />} {busy ? "Connecting…" : "Closing this panel keeps your session running"}</div>
    </div>}
    <footer className="terminal-control">
      {interactive ? <><div><Keyboard size={15} /><span>Automation paused for this chat</span></div><button className="terminal-secondary" disabled={busy} onClick={() => void endControl()}><Square size={12} />End control</button></>
      : view === "output" ? <div className="terminal-control-description"><span>Automated run logs</span><small>Raw process output for troubleshooting.</small></div>
      : <><div className="terminal-control-description"><span>{busy ? "Opening interactive CLI…" : "Interactive CLI"}</span><small>{workflowActive ? "Opening the CLI stops the automated workflow." : "Type directly into your bot’s command line."}</small></div><button className="terminal-primary" disabled={!supportsControl(selectedBot) || busy} onClick={() => void takeControl()}>{busy ? <Loader2 className="animate-spin" size={14} /> : <Keyboard size={14} />}{error ? "Retry connection" : selected && !isLive(selected) ? "Start new session" : "Open interactive CLI"}</button></>}

    </footer>
  </aside>;
}

function TerminalScreen({ session, open, screens, onError }: { session: TerminalSessionInfo; open: boolean; screens: Map<string, SavedScreen>; onError: (error: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const offset = useRef(0);
  const inputChain = useRef(Promise.resolve());
  const currentSession = useRef(session);
  currentSession.current = session;
  const [query, setQuery] = useState("");
  const [hasSelection, setHasSelection] = useState(false);
  const [copied, setCopied] = useState(false);
  const [historyTrimmed, setHistoryTrimmed] = useState(false);
  const queuedInputBytes = useRef(0);
  const resizeChain = useRef(Promise.resolve());
  /** Set by the output poller; input calls it so echoes appear without waiting for a backed-off poll. */
  const pollSoon = useRef<() => void>(() => {});

  useEffect(() => {
    if (!container.current) return;
    const saved = screens.get(session.id);
    const term = new Terminal({ cols: saved?.cols ?? 80, rows: saved?.rows ?? 24, fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, monospace', fontSize: 13, lineHeight: 1.25, overviewRuler: { width: 7 }, cursorBlink: true, cursorStyle: "bar", scrollback: 5000, convertEol: session.mode === "output", screenReaderMode: true,
      theme: { overviewRulerBorder: "transparent", scrollbarSliderBackground: "#ffffff12", scrollbarSliderHoverBackground: "#ffffff26", scrollbarSliderActiveBackground: "#ffffff38", background: "#0e0e0e", foreground: "#e4e4e7", cursor: "#f4f4f5", selectionBackground: "#3f3f46", black: "#171b20", red: "#f08a8a", green: "#9bdfb0", yellow: "#e8c58a", blue: "#91b9ec", magenta: "#c4a0e8", cyan: "#8dd8d1", white: "#d5d9df", brightBlack: "#6c7480", brightRed: "#ffaaaa", brightGreen: "#b7f4c7", brightYellow: "#f4dba4", brightBlue: "#adcfff", brightMagenta: "#ddbcff", brightCyan: "#b4efe7", brightWhite: "#f4f5f6" } });
    const fitAddon = new FitAddon(); const searchAddon = new SearchAddon(); const serialize = new SerializeAddon();
    term.loadAddon(fitAddon); term.loadAddon(searchAddon); term.loadAddon(serialize);
    term.attachCustomKeyEventHandler(event => !((event.metaKey || event.ctrlKey) && event.key === "`"));
    term.open(container.current); terminal.current = term; fit.current = fitAddon; search.current = searchAddon;
    offset.current = saved?.offset ?? 0;
    if (saved) term.write(saved.text);
    const send = (data: Uint8Array) => {
      if (currentSession.current.mode !== "interactive" || currentSession.current.status !== "running") return;
      if (queuedInputBytes.current + data.length > MAX_QUEUED_INPUT_BYTES) { onError("Terminal input is busy. Wait before pasting more text (64 KiB maximum)."); return; }
      queuedInputBytes.current += data.length;
      inputChain.current = inputChain.current.then(() => writeTerminal(session.id, data)).then(() => pollSoon.current()).catch(error => onError(String(error))).finally(() => { queuedInputBytes.current -= data.length; });
    };
    const data = term.onData(value => send(new TextEncoder().encode(value)));
    // onBinary delivers one byte per UTF-16 code unit (e.g. mouse reports), not text to UTF-8 encode.
    const binary = term.onBinary(value => send(Uint8Array.from(value, char => char.charCodeAt(0) & 0xff)));
    const selection = term.onSelectionChange(() => setHasSelection(term.hasSelection()));
    // App shortcuts must not steal control sequences from an interactive CLI.
    const stopKeys = (event: KeyboardEvent) => { if (event.key !== "`") event.stopPropagation(); };
    container.current.addEventListener("keydown", stopKeys);
    const element = container.current;
    return () => {
      element.removeEventListener("keydown", stopKeys); data.dispose(); binary.dispose(); selection.dispose(); terminal.current = null;
      // Disposal waits for the write flush below; detach now so a remount never shows two screens.
      term.element?.remove();
      // Flush any in-flight parser writes before saving the matching byte offset.
      term.write("", () => {
        screens.set(session.id, { text: serialize.serialize(), offset: offset.current, cols: term.cols, rows: term.rows });
        while (screens.size > 32) screens.delete(screens.keys().next().value!);
        term.dispose();
      });
    };
  }, [session.id, session.mode, screens, onError]);

  useEffect(() => {
    const term = terminal.current;
    if (!open || !term || !container.current) return;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    const resize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (disposed || !container.current?.clientWidth) return;
        fit.current?.fit();
        if (session.mode === "interactive" && session.status === "running") {
          const cols = Math.min(500, term.cols), rows = Math.min(300, term.rows);
          resizeChain.current = resizeChain.current.then(async () => {
            if (!disposed) await resizeTerminal(session.id, cols, rows);
          }).catch(error => { if (!disposed) onError(String(error)); });
        }
      }, 80);
    };
    const observer = new ResizeObserver(resize); observer.observe(container.current); resize();
    void document.fonts.ready.then(() => { if (!disposed) resize(); });
    return () => { disposed = true; clearTimeout(timer); observer.disconnect(); };
  }, [open, session.id, session.mode, session.status, onError]);

  useEffect(() => {
    const term = terminal.current;
    if (!open || !term) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    let pollAgain = false;
    // Back off while a live process is quiet; any output or keystroke snaps back to the fast rate.
    let delay = OUTPUT_POLL_MIN_MS;
    const schedule = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => void poll(), ms); };
    const poll = async () => {
      if (polling) { pollAgain = true; return; }
      polling = true;
      try {
        const result = await readTerminal(session.id, offset.current);
        if (disposed) return;
        if (result.truncated) { term.reset(); setHistoryTrimmed(true); }
        await new Promise<void>(resolve => term.write(result.data, () => { offset.current = result.offset; resolve(); }));
        if (disposed) return;
        if (result.data.length > 0 || pollAgain) delay = OUTPUT_POLL_MIN_MS;
        else delay = isLive(currentSession.current) ? Math.min(OUTPUT_POLL_MAX_MS, Math.round(delay * 1.5)) : OUTPUT_POLL_MAX_MS;
        schedule(result.data.length === READ_CHUNK_BYTES ? 0 : delay);
      } catch (error) {
        if (!disposed) { onError(String(error)); schedule(OUTPUT_POLL_ERROR_MS); }
      } finally {
        polling = false;
        pollAgain = false;
      }
    };
    pollSoon.current = () => { if (disposed) return; delay = OUTPUT_POLL_MIN_MS; if (polling) pollAgain = true; else schedule(OUTPUT_POLL_MIN_MS); };
    void poll();
    return () => { disposed = true; clearTimeout(timer); pollSoon.current = () => {}; };
  }, [open, session.id, onError]);

  useEffect(() => { if (open && session.mode === "interactive" && session.status === "running") terminal.current?.focus(); }, [open, session.id, session.mode, session.status]);

  useEffect(() => { if (terminal.current) { terminal.current.options.disableStdin = session.mode !== "interactive" || session.status !== "running"; terminal.current.options.cursorBlink = session.status === "running"; } }, [session.mode, session.status]);

  return <div className={`terminal-screen-wrap ${!isLive(session) ? "terminal-screen-ended" : ""}`}>
    <div className="terminal-tools"><Search size={13} /><input aria-label="Search terminal output" placeholder="Find in output…" value={query} onChange={event => { setQuery(event.target.value); search.current?.findNext(event.target.value); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (event.shiftKey) search.current?.findPrevious(query); else search.current?.findNext(query); } }} />
      <button className="terminal-icon" aria-label="Previous terminal match" disabled={!query} onClick={() => search.current?.findPrevious(query)}><ArrowUp size={13} /></button><button className="terminal-icon" aria-label="Next terminal match" disabled={!query} onClick={() => search.current?.findNext(query)}><ArrowDown size={13} /></button>
      <button className="terminal-icon" aria-label="Copy terminal selection" disabled={!hasSelection} onClick={() => { void navigator.clipboard.writeText(terminal.current?.getSelection() ?? "").then(() => setCopied(true)).catch(error => onError(String(error))); }} onBlur={() => setCopied(false)}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
    </div>
    {session.mode === "interactive" && !isLive(session) && <div className="terminal-retention" role="status">Session ended · Read-only transcript. Open a new CLI session to continue.</div>}
    {historyTrimmed && <div className="terminal-retention" role="status">Earlier output expired. Showing the most recent 2 MiB.</div>}
    <div ref={container} className="terminal-screen" aria-label={`${session.botName} ${session.mode === "interactive" ? "interactive terminal" : "process output"}`} />
  </div>;
}
