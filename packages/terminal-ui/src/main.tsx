import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { App, McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

interface TerminalViewState {
  session_id: string;
  agent_id?: string;
  agent_name?: string;
  cwd?: string;
  shell?: string;
  status: string;
  cursor: number;
  initial_output?: string;
  exit_code?: number | null;
}

interface TerminalStreamMeta {
  url: string;
  expires_at: string;
}

interface TerminalEvent {
  sequence: number;
  event_type: string;
  data: Record<string, unknown>;
}

interface HotReloadBootstrap {
  viewState: TerminalViewState | null;
  streamMeta: TerminalStreamMeta | null;
  lastSequence: number;
}

declare global {
  interface Window {
    __TERMINAL_HOT_BOOTSTRAP__?: HotReloadBootstrap;
  }
}

const hotBootstrap = window.__TERMINAL_HOT_BOOTSTRAP__;
delete window.__TERMINAL_HOT_BOOTSTRAP__;

export function parseViewState(result: CallToolResult | null): TerminalViewState | null {
  if (!result?.structuredContent || typeof result.structuredContent !== 'object') return null;
  const value = result.structuredContent as Record<string, unknown>;
  if (typeof value.session_id !== 'string' || typeof value.status !== 'string') return null;
  return {
    session_id: value.session_id,
    ...(typeof value.agent_id === 'string' ? { agent_id: value.agent_id } : {}),
    ...(typeof value.agent_name === 'string' ? { agent_name: value.agent_name } : {}),
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    ...(typeof value.shell === 'string' ? { shell: value.shell } : {}),
    status: value.status,
    cursor: typeof value.cursor === 'number' ? value.cursor : 0,
    ...(typeof value.initial_output === 'string' ? { initial_output: value.initial_output } : {}),
    ...(typeof value.exit_code === 'number' || value.exit_code === null ? { exit_code: value.exit_code } : {}),
  };
}

function parseTerminalEvent(raw: string): TerminalEvent {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('Terminal SSE event must be an object.');
  const value = parsed as Record<string, unknown>;
  const sequence = value.sequence;
  const eventType = value.event_type;
  const data = value.data;
  if (!Number.isInteger(sequence) || typeof sequence !== 'number' || sequence <= 0) throw new Error('Terminal SSE event has an invalid sequence.');
  if (typeof eventType !== 'string') throw new Error('Terminal SSE event has an invalid event type.');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Terminal SSE event has invalid data.');
  return { sequence, event_type: eventType, data: data as Record<string, unknown> };
}

export function parseStreamMeta(result: CallToolResult | null): TerminalStreamMeta | null {
  const meta = result?._meta;
  if (!meta || typeof meta !== 'object') return null;
  const terminalStream = (meta as Record<string, unknown>).terminal_stream;
  if (!terminalStream || typeof terminalStream !== 'object') return null;
  const data = terminalStream as Record<string, unknown>;
  return typeof data.url === 'string' && typeof data.expires_at === 'string'
    ? { url: data.url, expires_at: data.expires_at }
    : null;
}

export function mergeViewState(previous: TerminalViewState | null, next: TerminalViewState): TerminalViewState {
  if (!previous || previous.session_id !== next.session_id) return next;
  return { ...previous, ...next };
}

export function classifySequence(lastSequence: number, incomingSequence: number): 'stale' | 'next' | 'gap' {
  if (!Number.isInteger(incomingSequence) || incomingSequence <= 0) return 'gap';
  if (incomingSequence <= lastSequence) return 'stale';
  return incomingSequence === lastSequence + 1 ? 'next' : 'gap';
}

function isFinalStatus(status: string | undefined): boolean {
  return status === 'closed' || status === 'exited' || status === 'failed';
}

function controlsDisabled(status: string | undefined): boolean {
  return status === 'closing' || isFinalStatus(status);
}

function terminalErrorCode(result: CallToolResult): string | undefined {
  const terminalError = result._meta && typeof result._meta === 'object'
    ? (result._meta as Record<string, unknown>).terminal_error
    : undefined;
  if (!terminalError || typeof terminalError !== 'object') return undefined;
  const code = (terminalError as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

export function TerminalApp(): React.JSX.Element {
  const [toolResult, setToolResult] = useState<CallToolResult | null>(null);
  const [viewState, setViewState] = useState<TerminalViewState | null>(hotBootstrap?.viewState ?? null);
  const [streamOverride, setStreamOverride] = useState<TerminalStreamMeta | null>(hotBootstrap?.streamMeta ?? null);
  const [hostContext, setHostContext] = useState<McpUiHostContext>();
  const [streamState, setStreamState] = useState<'connecting' | 'live' | 'reconnecting' | 'offline'>('connecting');
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const fitAddonRef = useRef<FitAddon | undefined>(undefined);
  const eventSourceRef = useRef<EventSource | undefined>(undefined);
  const hotReloadSourceRef = useRef<EventSource | undefined>(undefined);
  const lastSequenceRef = useRef(hotBootstrap?.lastSequence ?? hotBootstrap?.viewState?.cursor ?? 0);
  const refreshInFlightRef = useRef(false);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const reconnectAttemptRef = useRef(0);
  const resizeTimerRef = useRef<number | undefined>(undefined);
  const fitFrameRef = useRef<number | undefined>(undefined);
  const lastResizeRef = useRef<{ sessionId: string; cols: number; rows: number } | undefined>(undefined);
  const viewStateRef = useRef<TerminalViewState | null>(viewState);
  const streamMetaRef = useRef<TerminalStreamMeta | null>(streamOverride);
  const outputQueueRef = useRef('');
  const outputFrameRef = useRef<number | undefined>(undefined);
  const hotReloadingRef = useRef(false);
  const initialStreamMeta = useMemo(() => parseStreamMeta(toolResult), [toolResult]);
  const streamMeta = streamOverride ?? initialStreamMeta;

  const applyToolResult = (result: CallToolResult) => {
    setToolResult(result);
    const nextViewState = parseViewState(result);
    if (nextViewState) setViewState((previous) => mergeViewState(previous, nextViewState));
    const meta = parseStreamMeta(result);
    if (meta) setStreamOverride(meta);
  };

  const { app, error } = useApp({
    appInfo: { name: 'ChatGPT Terminal', version: '0.3.0' },
    capabilities: {},
    onAppCreated: (createdApp) => {
      createdApp.ontoolresult = (result) => { applyToolResult(result); };
      createdApp.onhostcontextchanged = (next) => setHostContext((previous) => ({ ...previous, ...next }));
      createdApp.onteardown = () => {
        eventSourceRef.current?.close();
        hotReloadSourceRef.current?.close();
        clearReconnectTimer();
        if (resizeTimerRef.current !== undefined) window.clearTimeout(resizeTimerRef.current);
        if (fitFrameRef.current !== undefined) window.cancelAnimationFrame(fitFrameRef.current);
        flushTerminalOutput();
        terminalRef.current?.dispose();
        return Promise.resolve({});
      };
      createdApp.onerror = (appError) => console.error('[terminal-app]', appError);
    },
  });

  useHostStyles(app);

  function clearReconnectTimer(): void {
    if (reconnectTimerRef.current === undefined) return;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = undefined;
  }

  function flushTerminalOutput(): void {
    if (outputFrameRef.current !== undefined) {
      window.cancelAnimationFrame(outputFrameRef.current);
      outputFrameRef.current = undefined;
    }
    if (!outputQueueRef.current) return;
    const output = outputQueueRef.current;
    outputQueueRef.current = '';
    terminalRef.current?.write(output);
  }

  function queueTerminalOutput(text: string): void {
    // Use a single string accumulator instead of array + join to reduce allocations
    outputQueueRef.current += text;
    if (outputFrameRef.current !== undefined) return;
    outputFrameRef.current = window.requestAnimationFrame(() => {
      outputFrameRef.current = undefined;
      if (!outputQueueRef.current) return;
      const output = outputQueueRef.current;
      outputQueueRef.current = '';
      terminalRef.current?.write(output);
    });
  }

  function scheduleStreamReconnect(): void {
    const current = viewStateRef.current;
    if (!current || isFinalStatus(current.status) || reconnectTimerRef.current !== undefined) return;
    // Exponential backoff with ±25% jitter to avoid synchronized reconnect storms
    const base = Math.min(1000 * 2 ** reconnectAttemptRef.current, 15_000);
    const jitter = base * 0.25 * (2 * Math.random() - 1);
    const delayMs = Math.max(500, Math.round(base + jitter));
    reconnectAttemptRef.current += 1;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = undefined;
      refreshStream(true);
    }, delayMs);
  }

  function refreshStream(retryOnFailure: boolean): void {
    const current = viewStateRef.current;
    if (!app || !current || isFinalStatus(current.status) || refreshInFlightRef.current) return;
    clearReconnectTimer();
    refreshInFlightRef.current = true;
    setStreamState('reconnecting');
    void callTool(app, 'terminal_stream_refresh', {
      session_id: current.session_id,
      after: lastSequenceRef.current,
    }).then(async (result) => {
      if (result.isError && terminalErrorCode(result) === 'INVALID_CURSOR') {
        const statusResult = await callTool(app, 'terminal_status', { session_id: current.session_id });
        const statusState = parseViewState(statusResult);
        if (statusResult.isError || !statusState) throw new Error('Unable to resynchronize terminal stream cursor.');
        if (statusState.cursor > lastSequenceRef.current) {
          queueTerminalOutput('\r\n\x1b[33m[Live output gap: older terminal output was no longer retained]\x1b[0m\r\n');
        }
        lastSequenceRef.current = statusState.cursor;
        setViewState((previous) => mergeViewState(previous, statusState));
        result = await callTool(app, 'terminal_stream_refresh', {
          session_id: current.session_id,
          after: lastSequenceRef.current,
        });
      }
      if (result.isError) throw new Error(`Terminal stream refresh failed: ${terminalErrorCode(result) ?? 'unknown error'}`);
      const refreshed = parseStreamMeta(result);
      if (!refreshed) throw new Error('Terminal stream refresh returned no stream capability.');
      reconnectAttemptRef.current = 0;
      setStreamOverride(refreshed);
    }).catch((refreshError) => {
      console.error('[terminal-app] stream refresh failed', refreshError);
      setStreamState('reconnecting');
      if (retryOnFailure) scheduleStreamReconnect();
    }).finally(() => {
      refreshInFlightRef.current = false;
    });
  }

  useEffect(() => {
    if (app) setHostContext(app.getHostContext());
  }, [app]);

  useEffect(() => () => {
    clearReconnectTimer();
    flushTerminalOutput();
  }, []);

  useEffect(() => {
    viewStateRef.current = viewState;
    if (isFinalStatus(viewState?.status)) {
      clearReconnectTimer();
      flushTerminalOutput();
      eventSourceRef.current?.close();
      eventSourceRef.current = undefined;
      setStreamState('offline');
    }
  }, [viewState]);

  useEffect(() => {
    streamMetaRef.current = streamMeta;
  }, [streamMeta]);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host || terminalRef.current) return;
    const terminal = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      convertEol: false,
      scrollback: 12_000,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.18,
      allowProposedApi: false,
      theme: terminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    const scheduleFit = () => {
      if (fitFrameRef.current !== undefined) return;
      fitFrameRef.current = window.requestAnimationFrame(() => {
        fitFrameRef.current = undefined;
        fitAddon.fit();
      });
    };
    queueMicrotask(scheduleFit);

    const observer = new ResizeObserver(() => {
      scheduleFit();
      if (resizeTimerRef.current !== undefined) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = undefined;
        const currentViewState = viewStateRef.current;
        if (!app || !currentViewState || controlsDisabled(currentViewState.status)) return;
        const previous = lastResizeRef.current;
        if (previous?.sessionId === currentViewState.session_id && previous.cols === terminal.cols && previous.rows === terminal.rows) return;
        lastResizeRef.current = { sessionId: currentViewState.session_id, cols: terminal.cols, rows: terminal.rows };
        void callTool(app, 'terminal_resize', {
          session_id: currentViewState.session_id,
          cols: terminal.cols,
          rows: terminal.rows,
        }).catch((resizeError) => console.error('[terminal-app] resize failed', resizeError));
      }, 120);
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      if (resizeTimerRef.current !== undefined) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = undefined;
      if (fitFrameRef.current !== undefined) window.cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = undefined;
      flushTerminalOutput();
      terminal.dispose();
      terminalRef.current = undefined;
      fitAddonRef.current = undefined;
    };
  }, [app]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.theme = terminalTheme();
  }, [hostContext?.theme]);

  useEffect(() => {
    if (!viewState) return;
    if (!hotBootstrap || hotBootstrap.viewState?.session_id !== viewState.session_id) {
      lastSequenceRef.current = viewState.cursor;
    }
    lastResizeRef.current = undefined;
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    if (viewState.initial_output) terminalRef.current?.write(viewState.initial_output);
  }, [viewState?.session_id]);

  useEffect(() => {
    if (initialStreamMeta) setStreamOverride(initialStreamMeta);
  }, [initialStreamMeta?.url]);

  useEffect(() => {
    if (!app || !viewState || !streamMeta) return;
    const expiryMs = Date.parse(streamMeta.expires_at);
    if (!Number.isFinite(expiryMs)) {
      setStreamState('offline');
      return;
    }
    const refreshDelay = Math.max(1_000, expiryMs - Date.now() - 15_000);
    const timer = window.setTimeout(() => refreshStream(true), refreshDelay);
    return () => window.clearTimeout(timer);
  }, [app, viewState?.session_id, streamMeta?.expires_at]);

  useEffect(() => {
    eventSourceRef.current?.close();
    if (!streamMeta || !viewState) return;

    setStreamState('connecting');
    const source = new EventSource(streamMeta.url);
    eventSourceRef.current = source;
    source.onopen = () => {
      if (eventSourceRef.current !== source) return;
      reconnectAttemptRef.current = 0;
      setStreamState('live');
    };
    source.onerror = () => {
      if (eventSourceRef.current !== source) return;
      source.close();
      eventSourceRef.current = undefined;
      setStreamState('reconnecting');
      refreshStream(true);
    };
    source.onmessage = (message) => {
      if (eventSourceRef.current !== source) return;
      try {
        const rawData: unknown = message.data;
        if (typeof rawData !== 'string') throw new Error('Terminal SSE message data must be a string.');
        const event = parseTerminalEvent(rawData);
        const sequenceState = classifySequence(lastSequenceRef.current, event.sequence);
        if (sequenceState === 'stale') return;
        if (sequenceState === 'gap') {
          console.error('[terminal-app] SSE sequence gap', { expected: lastSequenceRef.current + 1, received: event.sequence });
          source.close();
          eventSourceRef.current = undefined;
          setStreamState('reconnecting');
          refreshStream(true);
          return;
        }
        lastSequenceRef.current = event.sequence;
        if (event.event_type === 'terminal.stdout' || event.event_type === 'terminal.stderr') {
          const text = event.data.text;
          if (typeof text === 'string') queueTerminalOutput(text);
        }
        if (event.event_type === 'cwd.changed' && typeof event.data.cwd === 'string') {
          setViewState((previous) => previous ? { ...previous, cwd: event.data.cwd as string } : previous);
        }
        if (event.event_type === 'process.exit' || event.event_type === 'session.closed') {
          flushTerminalOutput();
          clearReconnectTimer();
          setViewState((previous) => previous ? {
            ...previous,
            status: event.event_type === 'process.exit' ? 'exited' : 'closed',
            ...(typeof event.data.exit_code === 'number' ? { exit_code: event.data.exit_code } : {}),
          } : previous);
          setStreamState('offline');
          source.close();
          eventSourceRef.current = undefined;
        }
      } catch (parseError) {
        console.error('[terminal-app] invalid SSE event', parseError);
        source.close();
        eventSourceRef.current = undefined;
        setStreamState('reconnecting');
        refreshStream(true);
      }
    };

    return () => source.close();
  }, [streamMeta?.url, viewState?.session_id]);

  useEffect(() => {
    hotReloadSourceRef.current?.close();
    if (!streamMeta) return;
    let origin: string;
    try {
      origin = new URL(streamMeta.url).origin;
    } catch {
      return;
    }
    const source = new EventSource(`${origin}/terminal-ui/reload`);
    hotReloadSourceRef.current = source;
    source.onmessage = (message) => {
      if (hotReloadSourceRef.current !== source || hotReloadingRef.current) return;
      try {
        const payload = JSON.parse(String(message.data)) as { version?: unknown };
        if (typeof payload.version !== 'string') return;
        const currentVersion = document.querySelector<HTMLMetaElement>('meta[name="terminal-ui-version"]')?.content;
        if (currentVersion === payload.version) return;
        hotReloadingRef.current = true;
        const runtimeUrl = `${origin}/terminal-ui/runtime.html?v=${encodeURIComponent(payload.version)}`;
        void fetch(runtimeUrl, { cache: 'no-store' }).then(async (response) => {
          if (!response.ok) throw new Error(`UI runtime reload failed with HTTP ${response.status}.`);
          let html = await response.text();
          const bootstrap: HotReloadBootstrap = {
            viewState: viewStateRef.current,
            streamMeta: streamMetaRef.current,
            lastSequence: lastSequenceRef.current,
          };
          const serialized = JSON.stringify(bootstrap).replaceAll('<', '\\u003c');
          const closeScriptTag = `${String.fromCharCode(60, 47)}script>`;
          html = html.replace('</head>', `<script>window.__TERMINAL_HOT_BOOTSTRAP__=${serialized};${closeScriptTag}</head>`);
          flushTerminalOutput();
          source.close();
          document.open();
          document.write(html);
          document.close();
        }).catch((reloadError) => {
          hotReloadingRef.current = false;
          console.error('[terminal-app] hot reload failed', reloadError);
        });
      } catch (reloadError) {
        console.error('[terminal-app] invalid hot reload event', reloadError);
      }
    };
    source.onerror = () => {
      // EventSource reconnects automatically; UI hot reload must never affect the PTY SSE stream.
    };
    return () => source.close();
  }, [streamMeta?.url]);

  if (error) return (
    <main className="terminal-shell" data-state="failed">
      <header className="terminal-header">
        <div className="terminal-identity">
          <div className="terminal-kicker">CHATGPT LIVE TERMINAL</div>
          <div className="terminal-machine-row">
            <span className="terminal-machine">Connection Failed</span>
            <span className="terminal-status" data-state="failed"><span className="state-dot" />OFFLINE</span>
          </div>
        </div>
      </header>
      <section className="terminal-frame" aria-label="Terminal connection error">
        <div className="terminal-error">{error.message}</div>
      </section>
      <footer className="terminal-footer">
        <span>—</span>
        <span>DISCONNECTED</span>
      </footer>
    </main>
  );

  const displayState = isFinalStatus(viewState?.status) ? viewState?.status ?? 'offline' : streamState;
  return (
    <main className="terminal-shell" data-state={displayState}>
      <header className="terminal-header">
        <div className="terminal-identity">
          <div className="terminal-kicker">CHATGPT LIVE TERMINAL</div>
          <div className="terminal-machine-row">
            <span className="terminal-machine">{viewState?.agent_name ?? viewState?.agent_id ?? 'Connecting to computer'}</span>
            <span className="terminal-status" data-state={displayState}>
              <span className="state-dot" />
              {displayState.toUpperCase()}
            </span>
          </div>
          <div className="terminal-path" title={viewState?.cwd}>{viewState?.cwd ?? 'Waiting for terminal session…'}</div>
        </div>
      </header>

      <section className="terminal-frame" aria-label="Real-time ChatGPT terminal activity over SSE">
        <div ref={terminalHostRef} className="terminal-host" />
      </section>

      <footer className="terminal-footer">
        <span>{viewState?.shell ?? 'shell'}</span>
        <span>SSE {streamState.toUpperCase()}</span>
        {viewState?.exit_code != null ? <span className="terminal-exit" data-success={viewState.exit_code === 0 ? 'true' : 'false'}>EXIT {viewState.exit_code}</span> : null}
      </footer>
    </main>
  );
}

async function callTool(app: App, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return app.callServerTool({ name, arguments: args });
}

export function terminalTheme() {
  return {
    background: '#070a0f',
    foreground: '#e6edf3',
    cursor: '#7ee787',
    selectionBackground: '#1f6feb66',
    black: '#0d1117',
    brightBlack: '#6e7681',
    green: '#3fb950',
    brightGreen: '#56d364',
    cyan: '#39c5cf',
    brightCyan: '#56d4dd',
  };
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(<TerminalApp />);
