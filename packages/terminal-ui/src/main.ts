import './styles.css';

export interface CallToolResult {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
}

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

interface TerminalSurfaceState {
  surface_id: string | null;
  surface_open: boolean;
  surface_active: boolean;
  session_id: string | null;
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

interface TerminalReadResult {
  output: string;
  events: TerminalEvent[] | null;
  next_cursor: number;
  has_more: boolean;
  status: string;
  exit_code: number | null;
}

export interface TerminalAppBridge {
  ontoolresult: ((result: CallToolResult) => void) | undefined;
  onhostcontextchanged: ((context: Record<string, unknown>) => void) | undefined;
  onteardown: (() => Promise<Record<string, never>>) | undefined;
  onerror: ((error: Error) => void) | undefined;
  callServerTool(params: { name: string; arguments: Record<string, unknown> }): Promise<CallToolResult>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
}

interface ChatGptOpenAiCompat {
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  toolOutput?: unknown;
  theme?: unknown;
}

type JsonRpcId = number | string;
type StreamState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'failed';

const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
const MAX_OUTPUT_CHARS = 600_000;
const OUTPUT_TRIM_TARGET = 450_000;
const STREAM_REFRESH_MARGIN_MS = 15_000;
const SSE_CONNECT_TIMEOUT_MS = 2_000;
const BRIDGE_REQUEST_TIMEOUT_MS = 15_000;
const SURFACE_POLL_INTERVAL_MS = 500;

export class ChatGptMcpBridge implements TerminalAppBridge {
  ontoolresult: ((result: CallToolResult) => void) | undefined;
  onhostcontextchanged: ((context: Record<string, unknown>) => void) | undefined;
  onteardown: (() => Promise<Record<string, never>>) | undefined;
  onerror: ((error: Error) => void) | undefined;

  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private listening = false;
  private openAi: ChatGptOpenAiCompat | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private resizeFrame: number | undefined;
  private lastReportedHeight = 0;

  async connect(): Promise<void> {
    if (this.listening) return;
    const openAi = getChatGptOpenAiCompat();
    if (openAi) {
      this.listening = true;
      this.openAi = openAi;
      window.addEventListener('openai:set_globals', this.handleOpenAiGlobals as EventListener);
      const initial = normalizeCompatCallToolResult(openAi.toolOutput);
      if (initial) this.ontoolresult?.(initial);
      if (typeof openAi.theme === 'string') this.onhostcontextchanged?.({ theme: openAi.theme });
      return;
    }

    this.listening = true;
    window.addEventListener('message', this.handleMessage);
    try {
      const initialized = await this.request('ui/initialize', {
        appInfo: { name: 'ChatGPT Terminal', version: '0.12.0' },
        appCapabilities: {},
        protocolVersion: MCP_APPS_PROTOCOL_VERSION,
      });
      if (isRecord(initialized.hostContext)) this.onhostcontextchanged?.(initialized.hostContext);
      this.notify('ui/notifications/initialized', {});
      this.startAutoResize();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  callServerTool(params: { name: string; arguments: Record<string, unknown> }): Promise<CallToolResult> {
    if (this.openAi) {
      return this.openAi.callTool(params.name, params.arguments).then((result) => {
        const normalized = normalizeCompatCallToolResult(result);
        if (!normalized) throw new Error('ChatGPT returned an invalid callTool result.');
        return normalized;
      });
    }
    return this.request('tools/call', params).then((result) => {
      const normalized = normalizeCallToolResult(result);
      if (!normalized) throw new Error('Host returned an invalid tools/call result.');
      return normalized;
    });
  }

  close(): Promise<void> {
    if (!this.listening) return Promise.resolve();
    this.listening = false;
    window.removeEventListener('message', this.handleMessage);
    window.removeEventListener('openai:set_globals', this.handleOpenAiGlobals as EventListener);
    this.openAi = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    if (this.resizeFrame !== undefined) window.cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = undefined;
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error('MCP App bridge closed.'));
    }
    this.pending.clear();
    return Promise.resolve();
  }

  private readonly handleOpenAiGlobals = (event: CustomEvent<unknown>): void => {
    const detail = isRecord(event.detail) ? event.detail : undefined;
    const globals = detail && isRecord(detail.globals) ? detail.globals : undefined;
    if (!globals) return;
    if ('toolOutput' in globals) {
      const result = normalizeCompatCallToolResult(globals.toolOutput);
      if (result) this.ontoolresult?.(result);
    }
    if (typeof globals.theme === 'string') this.onhostcontextchanged?.({ theme: globals.theme });
  };

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== window.parent || !isRecord(event.data)) return;
    const message = event.data;
    if (message.jsonrpc !== '2.0') return;

    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      window.clearTimeout(pending.timer);
      if (isRecord(message.error)) {
        pending.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'MCP App request failed.'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== 'string') return;
    if ('id' in message && (typeof message.id === 'number' || typeof message.id === 'string')) {
      void this.handleRequest(message.id, message.method);
      return;
    }
    this.handleNotification(message.method, isRecord(message.params) ? message.params : {});
  };

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'ui/notifications/tool-result') {
      const result = normalizeCallToolResult(params);
      if (result) this.ontoolresult?.(result);
      return;
    }
    if (method === 'ui/notifications/host-context-changed') {
      this.onhostcontextchanged?.(params);
    }
  }

  private async handleRequest(id: JsonRpcId, method: string): Promise<void> {
    if (method === 'ping') {
      this.respond(id, {});
      return;
    }
    if (method === 'ui/resource-teardown') {
      try {
        const result = await this.onteardown?.() ?? {};
        this.respond(id, result);
      } catch (error) {
        this.respondError(id, -32603, errorMessage(error));
      }
      return;
    }
    this.respondError(id, -32601, `Unsupported MCP App request: ${method}`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP App request timed out: ${method}`));
      }, BRIDGE_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: (value) => resolve(isRecord(value) ? value : {}), reject, timer });
      this.post({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.post({ jsonrpc: '2.0', method, params });
  }

  private respond(id: JsonRpcId, result: Record<string, unknown>): void {
    this.post({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    this.post({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private post(message: Record<string, unknown>): void {
    window.parent.postMessage(message, '*');
  }

  private startAutoResize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    const schedule = () => {
      if (this.resizeFrame !== undefined) return;
      this.resizeFrame = window.requestAnimationFrame(() => {
        this.resizeFrame = undefined;
        const height = Math.ceil(document.documentElement.scrollHeight);
        if (height <= 0 || Math.abs(height - this.lastReportedHeight) < 2) return;
        this.lastReportedHeight = height;
        this.notify('ui/notifications/size-changed', { height });
      });
    };
    this.resizeObserver = new ResizeObserver(schedule);
    this.resizeObserver.observe(document.documentElement);
    schedule();
  }
}

export function parseViewState(result: CallToolResult | null): TerminalViewState | null {
  if (!result) return null;
  const value = structuredPayload(result);
  if (!value) return null;
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

export function parseStreamMeta(result: CallToolResult | null): TerminalStreamMeta | null {
  const terminalStream = result?._meta?.terminal_stream;
  if (!isRecord(terminalStream)) return null;
  return typeof terminalStream.url === 'string' && typeof terminalStream.expires_at === 'string'
    ? { url: terminalStream.url, expires_at: terminalStream.expires_at }
    : null;
}

function parseSurfaceState(result: CallToolResult | null): TerminalSurfaceState | null {
  if (!result) return null;
  const value = structuredPayload(result);
  if (!value || typeof value.surface_open !== 'boolean' || typeof value.surface_active !== 'boolean') return null;
  const surfaceId = value.surface_id;
  const sessionId = value.session_id;
  if (surfaceId !== null && typeof surfaceId !== 'string') return null;
  if (sessionId !== null && typeof sessionId !== 'string') return null;
  return {
    surface_id: surfaceId,
    surface_open: value.surface_open,
    surface_active: value.surface_active,
    session_id: sessionId,
  };
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

export function normalizeTerminalText(input: string): string {
  let output = '';
  let index = 0;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code === 0x1b) {
      const next = input[index + 1];
      if (next === '[') {
        index += 2;
        while (index < input.length) {
          const control = input.charCodeAt(index++);
          if (control >= 0x40 && control <= 0x7e) break;
        }
        continue;
      }
      if (next === ']') {
        index += 2;
        while (index < input.length) {
          const control = input.charCodeAt(index);
          if (control === 0x07) {
            index += 1;
            break;
          }
          if (control === 0x1b && input[index + 1] === '\\') {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
      index += Math.min(2, input.length - index);
      continue;
    }
    if (code === 0x08) {
      output = output.slice(0, -1);
      index += 1;
      continue;
    }
    if (code === 0x0d) {
      if (input.charCodeAt(index + 1) === 0x0a) index += 1;
      output += '\n';
      index += 1;
      continue;
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) {
      index += 1;
      continue;
    }
    output += input[index] ?? '';
    index += 1;
  }
  return output;
}


const TERM_RE = /(^.*?[$#>]\s)([\w./:+-]+)?|(^\s*(?:\/\/|#\s)[^\n]*)|\b(ERROR|FAIL|FATAL|EXCEPTION)\b|\b(WARN(?:ING)?)\b|\b(PASS|SUCCESS|DONE|OK)\b|("[^"\n]*"|'[^'\n]*')|(--?[\w-]+)|((?:~|\.{1,2})?\/[^\s"';|&]+)|(\b\d+(?:\.\d+)?\b)|\b(const|let|var|function|class|if|else|for|while|return|import|from|export|async|await|new|true|false|null|undefined)\b/gim;
const TERM_KIND = ['', 'prompt','command','comment','error','warning','success','string','option','path','number','keyword'];

export function highlightTerminalText(doc: Document, input: string): DocumentFragment {
  const text = normalizeTerminalText(input), out = doc.createDocumentFragment();
  let end = 0;
  const add = (value: string, kind: number) => { const span = doc.createElement('span'); span.className = `term-${TERM_KIND[kind]}`; span.textContent = value; out.appendChild(span); };
  TERM_RE.lastIndex = 0;
  for (const match of text.matchAll(TERM_RE)) {
    const at = match.index ?? 0;
    if (at > end) out.append(text.slice(end, at));
    if (match[1]) { add(match[1], 1); if (match[2]) add(match[2], 2); }
    else add(match[0], match.slice(1).findIndex(Boolean) + 1);
    end = at + match[0].length;
  }
  if (end < text.length) out.append(text.slice(end));
  return out;
}

export function appendRichTerminalText(container: HTMLElement, input: string, overflow = false): void {
  const doc = container.ownerDocument, out = doc.createDocumentFragment(), colors = 'black red green yellow blue magenta cyan white'.split(' ');
  let at = 0, color = '', bold = false;
  const add = (text: string) => {
    if (!text) return;
    const part = highlightTerminalText(doc, text);
    if (!color && !bold) out.appendChild(part);
    else { const span = doc.createElement('span'); span.className = `${color ? `term-${color}` : ''}${bold ? ' term-bold' : ''}`; span.appendChild(part); out.appendChild(span); }
  };
  for (const match of input.matchAll(new RegExp(String.fromCharCode(27) + '\\[([0-9;]*)m', 'g'))) {
    const pos = match.index ?? 0;
    add(input.slice(at, pos));
    for (const code of (match[1] || '0').split(';').map(Number)) {
      if (!code) { color = ''; bold = false; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) color = '';
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) color = colors[code >= 90 ? code - 90 : code - 30] ?? '';
    }
    at = pos + match[0].length;
  }
  add(input.slice(at));
  const text = out.textContent ?? '';
  const reduced = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (overflow && !reduced && text.length < 4096 && text.indexOf('\n') !== text.lastIndexOf('\n')) {
    const slot = doc.createElement('span');
    slot.className = 'term-overflow';
    slot.appendChild(out);
    container.appendChild(slot);
    setTimeout(() => slot.replaceWith(...slot.childNodes), 180);
    return;
  }
  container.appendChild(out);
}

function parseTerminalEventValue(parsed: unknown): TerminalEvent {
  if (!isRecord(parsed)) throw new Error('Terminal event must be an object.');
  const sequence = parsed.sequence;
  const eventType = parsed.event_type;
  const data = parsed.data;
  if (!Number.isInteger(sequence) || typeof sequence !== 'number' || sequence <= 0) throw new Error('Terminal event has an invalid sequence.');
  if (typeof eventType !== 'string') throw new Error('Terminal event has an invalid event type.');
  if (!isRecord(data)) throw new Error('Terminal event has invalid data.');
  return { sequence, event_type: eventType, data };
}

function parseTerminalEvent(raw: string): TerminalEvent {
  return parseTerminalEventValue(JSON.parse(raw));
}

function parseTerminalReadResult(result: CallToolResult): TerminalReadResult | null {
  const value = structuredPayload(result);
  if (!value) return null;
  const output = value.output;
  const nextCursor = value.next_cursor;
  const hasMore = value.has_more;
  const status = value.status;
  const exitCode = value.exit_code;
  if (typeof output !== 'string') return null;
  if (!Number.isInteger(nextCursor) || typeof nextCursor !== 'number' || nextCursor < 0) return null;
  if (typeof hasMore !== 'boolean' || typeof status !== 'string') return null;
  if (exitCode !== undefined && exitCode !== null && typeof exitCode !== 'number') return null;

  let events: TerminalEvent[] | null = null;
  if (Array.isArray(value.events)) {
    try {
      events = value.events.map(parseTerminalEventValue);
    } catch {
      events = null;
    }
  }
  return {
    output,
    events,
    next_cursor: nextCursor,
    has_more: hasMore,
    status,
    exit_code: typeof exitCode === 'number' ? exitCode : null,
  };
}

function isFinalStatus(status: string | undefined): boolean {
  return status === 'closed' || status === 'exited' || status === 'failed';
}

function terminalErrorCode(result: CallToolResult): string | undefined {
  const terminalError = result._meta?.terminal_error;
  if (isRecord(terminalError) && typeof terminalError.code === 'string') return terminalError.code;
  const text = firstTextContent(result);
  const match = text?.match(/^([A-Z][A-Z0-9_]+):/);
  return match?.[1];
}

export class TerminalViewer {
  private viewState: TerminalViewState | null = null;
  private streamState: StreamState = 'connecting';
  private eventSource: EventSource | undefined;
  private styleSource: EventSource | undefined;
  private lastSequence = 0;
  private refreshInFlight = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | undefined;
  private refreshTimer: number | undefined;
  private readRetryTimer: number | undefined;
  private readFallbackGeneration = 0;
  private readFallbackActive = false;
  private transportMode: 'sse' | 'mcp' = 'sse';
  private outputFrame: number | undefined;
  private outputQueue = '';
  private hasLiveOutput = false;
  private hotReloadVersion: string | undefined;
  private surfaceId: string | undefined;
  private surfacePollTimer: number | undefined;
  private surfacePollInFlight = false;
  private bridgeReady = false;

  private readonly shell: HTMLElement;
  private readonly machine: HTMLElement;
  private readonly status: HTMLElement;
  private readonly path: HTMLElement;
  private readonly output: HTMLElement;
  private readonly footerShell: HTMLElement;
  private readonly footerStream: HTMLElement;
  private readonly exit: HTMLElement;

  constructor(
    private readonly app: TerminalAppBridge,
    private readonly doc: Document = document,
  ) {
    this.shell = requireElement(doc, 'terminal-shell');
    this.machine = requireElement(doc, 'terminal-machine');
    this.status = requireElement(doc, 'terminal-status');
    this.path = requireElement(doc, 'terminal-path');
    this.output = requireElement(doc, 'terminal-output');
    this.footerShell = requireElement(doc, 'terminal-shell-name');
    this.footerStream = requireElement(doc, 'terminal-stream-state');
    this.exit = requireElement(doc, 'terminal-exit');
  }

  bind(): void {
    this.app.ontoolresult = (result) => this.applyToolResult(result);
    this.app.onhostcontextchanged = (context) => {
      const theme = context.theme;
      if (typeof theme === 'string') this.doc.documentElement.dataset.theme = theme;
    };
    this.app.onteardown = async () => {
      this.stopSurfaceSync();
      try {
        await this.callTool('terminal_turn_close', {});
      } catch (error) {
        console.error('[terminal-app] turn cleanup failed', error);
      }
      this.destroy();
      return {};
    };
    this.app.onerror = (error) => {
      console.error('[terminal-app]', error);
      this.showBridgeFailure(error);
    };
  }

  markBridgeReady(): void {
    this.bridgeReady = true;
    this.shell.dataset.bridge = 'ready';
    if (this.surfaceId) this.startSurfaceSync();
  }

  showBridgeFailure(error: unknown): void {
    this.streamState = 'failed';
    this.shell.dataset.bridge = 'failed';
    this.renderState();
    this.queueOutput(`\n[Terminal UI bridge failed: ${errorMessage(error)}]\n`);
  }

  applyToolResult(result: CallToolResult): void {
    const surface = parseSurfaceState(result);
    if (!this.surfaceId && surface?.surface_id) {
      this.surfaceId = surface.surface_id;
      if (this.bridgeReady) this.startSurfaceSync();
    }
    if (surface?.surface_id && this.surfaceId && surface.surface_id !== this.surfaceId) return;
    if (surface && !surface.surface_open) {
      this.stopSurfaceSync();
      this.finishStream();
      this.viewState = null;
      this.machine.textContent = 'Terminal turn complete';
      this.path.textContent = 'A fresh terminal will open on the next prompt.';
      this.path.title = '';
      this.renderState();
      return;
    }

    const next = parseViewState(result);
    if (next) {
      const previousSession = this.viewState?.session_id;
      const resultSurfaceId = surface?.surface_id;
      const canSwitch = previousSession === undefined || previousSession === next.session_id || (Boolean(resultSurfaceId) && resultSurfaceId === this.surfaceId);
      if (!canSwitch) return;
      this.viewState = mergeViewState(this.viewState, next);
      if (previousSession !== next.session_id) {
        this.eventSource?.close();
        this.eventSource = undefined;
        this.clearReconnectTimer();
        this.clearRefreshTimer();
        this.stopReadFallback();
        this.transportMode = 'sse';
        this.lastSequence = next.cursor;
        this.reconnectAttempt = 0;
        this.hasLiveOutput = false;
        this.output.textContent = '';
        if (next.initial_output) this.queueOutput(next.initial_output);
      }
      this.renderState();
    }

    const meta = parseStreamMeta(result);
    if (meta) this.useStream(meta);
    if (this.viewState && isFinalStatus(this.viewState.status)) this.finishStream();
  }

  destroy(): void {
    this.stopSurfaceSync();
    this.eventSource?.close();
    this.styleSource?.close();
    this.eventSource = undefined;
    this.styleSource = undefined;
    this.clearReconnectTimer();
    this.clearRefreshTimer();
    this.stopReadFallback();
    this.flushOutput();
  }

  private startSurfaceSync(): void {
    if (!this.surfaceId || this.surfacePollTimer !== undefined) return;
    void this.pollSurface();
    this.surfacePollTimer = window.setInterval(() => void this.pollSurface(), SURFACE_POLL_INTERVAL_MS);
  }

  private stopSurfaceSync(): void {
    if (this.surfacePollTimer !== undefined) window.clearInterval(this.surfacePollTimer);
    this.surfacePollTimer = undefined;
  }

  private async pollSurface(): Promise<void> {
    const surfaceId = this.surfaceId;
    if (!surfaceId || this.surfacePollInFlight) return;
    this.surfacePollInFlight = true;
    try {
      const previousSession = this.viewState?.session_id;
      const result = await this.callTool('terminal_surface_status', { surface_id: surfaceId, session_id: previousSession ?? null });
      const surface = parseSurfaceState(result);
      if (!result.isError && this.surfaceId === surfaceId && surface?.surface_id === surfaceId) {
        this.applyToolResult(result);
        if (surface.session_id && surface.session_id !== previousSession) this.refreshStream(false);
      }
    } catch (error) {
      console.error('[terminal-app] surface sync failed', error);
    } finally {
      this.surfacePollInFlight = false;
    }
  }

  private useStream(meta: TerminalStreamMeta): void {
    this.connectTerminalStream(meta);
    this.connectStyleReload(meta);
    this.scheduleCapabilityRefresh(meta);
  }

  private connectTerminalStream(meta: TerminalStreamMeta): void {
    this.eventSource?.close();
    if (!this.viewState || isFinalStatus(this.viewState.status)) return;
    if (!this.readFallbackActive) {
      this.transportMode = 'sse';
      this.streamState = 'connecting';
      this.renderState();
    }
    const source = new EventSource(meta.url);
    this.eventSource = source;
    window.setTimeout(() => {
      if (this.eventSource !== source || this.streamState !== 'connecting' || isFinalStatus(this.viewState?.status)) return;
      source.close();
      this.eventSource = undefined;
      this.startReadFallback();
      this.scheduleStreamReconnect();
    }, SSE_CONNECT_TIMEOUT_MS);

    source.onopen = () => {
      if (this.eventSource !== source) return;
      this.stopReadFallback();
      this.transportMode = 'sse';
      this.reconnectAttempt = 0;
      this.streamState = 'live';
      this.renderState();
    };
    source.onerror = () => {
      if (this.eventSource !== source || isFinalStatus(this.viewState?.status)) return;
      source.close();
      this.eventSource = undefined;
      this.startReadFallback();
      if (!this.readFallbackActive) {
        this.streamState = 'reconnecting';
        this.renderState();
      }
      this.scheduleStreamReconnect();
    };
    source.onmessage = (message) => {
      if (this.eventSource !== source) return;
      try {
        if (typeof message.data !== 'string') throw new Error('Terminal SSE message data must be a string.');
        this.acceptEvent(parseTerminalEvent(message.data), source);
      } catch (error) {
        console.error('[terminal-app] invalid SSE event', error);
        source.close();
        if (this.eventSource === source) this.eventSource = undefined;
        this.streamState = 'reconnecting';
        this.renderState();
        this.scheduleStreamReconnect();
      }
    };
  }

  private acceptEvent(event: TerminalEvent, source?: EventSource): 'accepted' | 'stale' | 'gap' {
    const sequenceState = classifySequence(this.lastSequence, event.sequence);
    if (sequenceState === 'stale') return 'stale';
    if (sequenceState === 'gap') {
      console.error('[terminal-app] terminal sequence gap', { expected: this.lastSequence + 1, received: event.sequence });
      if (source) {
        source.close();
        if (this.eventSource === source) this.eventSource = undefined;
        this.streamState = 'reconnecting';
        this.renderState();
        this.refreshStream(true);
      }
      return 'gap';
    }
    this.lastSequence = event.sequence;
    if (event.event_type === 'terminal.stdout' || event.event_type === 'terminal.stderr') {
      const text = event.data.text;
      if (typeof text === 'string') this.queueOutput(text);
      return 'accepted';
    }
    if (event.event_type === 'cwd.changed' && typeof event.data.cwd === 'string' && this.viewState) {
      this.viewState = { ...this.viewState, cwd: event.data.cwd };
      this.renderState();
      return 'accepted';
    }
    if ((event.event_type === 'process.exit' || event.event_type === 'session.closed') && this.viewState) {
      this.viewState = {
        ...this.viewState,
        status: event.event_type === 'process.exit' ? 'exited' : 'closed',
        ...(typeof event.data.exit_code === 'number' ? { exit_code: event.data.exit_code } : {}),
      };
      this.flushOutput();
      this.finishStream();
      this.renderState();
    }
    return 'accepted';
  }

  private finishStream(): void {
    this.eventSource?.close();
    this.eventSource = undefined;
    this.clearReconnectTimer();
    this.clearRefreshTimer();
    this.stopReadFallback();
    this.streamState = 'offline';
  }

  private startReadFallback(): void {
    if (this.readFallbackActive || !this.viewState || isFinalStatus(this.viewState.status)) return;
    this.clearReadRetryTimer();
    this.readFallbackActive = true;
    const generation = ++this.readFallbackGeneration;
    this.transportMode = 'mcp';
    this.streamState = 'connecting';
    this.renderState();
    void this.runReadFallback(generation);
  }

  private stopReadFallback(): void {
    this.readFallbackActive = false;
    this.readFallbackGeneration += 1;
    this.clearReadRetryTimer();
  }

  private async runReadFallback(generation: number): Promise<void> {
    try {
      while (this.readFallbackActive && generation === this.readFallbackGeneration) {
        const current = this.viewState;
        if (!current || isFinalStatus(current.status)) return;
        const result = await this.callTool('terminal_read', {
          session_id: current.session_id,
          after: this.lastSequence,
          max_bytes: 32_768,
          wait_ms: 1_000,
        });
        if (!this.readFallbackActive || generation !== this.readFallbackGeneration) return;
        if (result.isError && terminalErrorCode(result) === 'INVALID_CURSOR') {
          await this.resynchronizeCursor(current.session_id);
          continue;
        }
        if (result.isError) throw new Error(`Terminal read fallback failed: ${terminalErrorCode(result) ?? 'unknown error'}`);
        const read = parseTerminalReadResult(result);
        if (!read) throw new Error('Terminal read fallback returned an invalid result.');

        let sequenceGap = false;
        if (read.events && read.events.length > 0) {
          for (const event of read.events) {
            if (this.acceptEvent(event) === 'gap') {
              sequenceGap = true;
              break;
            }
            if (!this.readFallbackActive || generation !== this.readFallbackGeneration) return;
          }
        } else if (read.next_cursor > this.lastSequence) {
          if (read.output) this.queueOutput(read.output);
          this.lastSequence = read.next_cursor;
        }
        if (sequenceGap) {
          await this.resynchronizeCursor(current.session_id);
          continue;
        }

        this.transportMode = 'mcp';
        this.streamState = 'live';
        if (this.viewState?.session_id === current.session_id) {
          this.viewState = { ...this.viewState, status: read.status, exit_code: read.exit_code };
          if (isFinalStatus(read.status)) {
            this.flushOutput();
            this.finishStream();
            this.renderState();
            return;
          }
          this.renderState();
        }
      }
    } catch (error) {
      if (!this.readFallbackActive || generation !== this.readFallbackGeneration) return;
      console.error('[terminal-app] MCP read fallback failed', error);
      this.readFallbackActive = false;
      this.readFallbackGeneration += 1;
      this.transportMode = 'sse';
      this.streamState = 'reconnecting';
      this.renderState();
      this.readRetryTimer = window.setTimeout(() => {
        this.readRetryTimer = undefined;
        this.startReadFallback();
      }, 1_000);
    }
  }

  private async resynchronizeCursor(sessionId: string): Promise<void> {
    const statusResult = await this.callTool('terminal_status', { session_id: sessionId });
    const status = parseViewState(statusResult);
    if (statusResult.isError || !status) throw new Error('Unable to resynchronize terminal cursor.');
    if (status.cursor > this.lastSequence) this.queueOutput('\n[Live output gap: older terminal output was no longer retained]\n');
    this.lastSequence = status.cursor;
    this.viewState = mergeViewState(this.viewState, status);
    this.renderState();
  }

  private scheduleStreamReconnect(): void {
    if (!this.viewState || isFinalStatus(this.viewState.status) || this.reconnectTimer !== undefined) return;
    const base = Math.min(500 * 2 ** this.reconnectAttempt, 10_000);
    const jitter = base * 0.2 * (2 * Math.random() - 1);
    const delay = Math.min(10_000, Math.max(250, Math.round(base + jitter)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.refreshStream(true);
    }, delay);
  }

  private refreshStream(retryOnFailure: boolean): void {
    const current = this.viewState;
    if (!current || isFinalStatus(current.status) || this.refreshInFlight) return;
    this.clearReconnectTimer();
    this.refreshInFlight = true;
    if (!this.readFallbackActive) {
      this.transportMode = 'sse';
      this.streamState = 'reconnecting';
      this.renderState();
    }
    void this.callTool('terminal_stream_refresh', {
      session_id: current.session_id,
      after: this.lastSequence,
    }).then(async (result) => {
      if (result.isError && terminalErrorCode(result) === 'INVALID_CURSOR') {
        await this.resynchronizeCursor(current.session_id);
        result = await this.callTool('terminal_stream_refresh', {
          session_id: current.session_id,
          after: this.lastSequence,
        });
      }
      if (result.isError) throw new Error(`Terminal stream refresh failed: ${terminalErrorCode(result) ?? 'unknown error'}`);
      const refreshed = parseStreamMeta(result);
      if (!refreshed) throw new Error('Terminal stream refresh returned no stream capability.');
      this.useStream(refreshed);
    }).catch((error) => {
      console.error('[terminal-app] stream refresh failed', error);
      this.startReadFallback();
      if (!this.readFallbackActive) {
        this.transportMode = 'sse';
        this.streamState = 'reconnecting';
        this.renderState();
      }
      if (retryOnFailure) this.scheduleStreamReconnect();
    }).finally(() => {
      this.refreshInFlight = false;
    });
  }

  private scheduleCapabilityRefresh(meta: TerminalStreamMeta): void {
    this.clearRefreshTimer();
    const expiry = Date.parse(meta.expires_at);
    if (!Number.isFinite(expiry)) return;
    const delay = Math.max(1_000, expiry - Date.now() - STREAM_REFRESH_MARGIN_MS);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshStream(true);
    }, delay);
  }

  private connectStyleReload(meta: TerminalStreamMeta): void {
    let origin: string;
    try {
      origin = new URL(meta.url).origin;
    } catch {
      return;
    }
    const reloadUrl = `${origin}/terminal-ui/reload`;
    if (this.styleSource?.url === reloadUrl) return;
    this.styleSource?.close();
    const source = new EventSource(reloadUrl);
    this.styleSource = source;
    source.onmessage = (message) => {
      if (this.styleSource !== source) return;
      try {
        const payload = JSON.parse(String(message.data)) as { version?: unknown; kind?: unknown };
        if (payload.kind !== 'styles' || typeof payload.version !== 'string' || payload.version === this.hotReloadVersion) return;
        this.hotReloadVersion = payload.version;
        const styleUrl = `${origin}/terminal-ui/styles.css?v=${encodeURIComponent(payload.version)}`;
        void fetch(styleUrl, { cache: 'no-store' }).then(async (response) => {
          if (!response.ok) throw new Error(`UI stylesheet reload failed with HTTP ${response.status}.`);
          const css = await response.text();
          let liveStyles = this.doc.querySelector<HTMLStyleElement>('#terminal-live-styles');
          if (!liveStyles) {
            liveStyles = this.doc.createElement('style');
            liveStyles.id = 'terminal-live-styles';
            this.doc.head.appendChild(liveStyles);
          }
          liveStyles.textContent = css;
        }).catch((error) => {
          if (this.hotReloadVersion === payload.version) this.hotReloadVersion = undefined;
          console.error('[terminal-app] stylesheet reload failed', error);
        });
      } catch (error) {
        console.error('[terminal-app] invalid stylesheet reload event', error);
      }
    };
  }

  private queueOutput(text: string): void {
    if (!text) return;
    this.outputQueue += text;
    if (this.outputFrame !== undefined) return;
    this.outputFrame = window.requestAnimationFrame(() => {
      this.outputFrame = undefined;
      this.flushOutput();
    });
  }

  private flushOutput(): void {
    if (this.outputFrame !== undefined) {
      window.cancelAnimationFrame(this.outputFrame);
      this.outputFrame = undefined;
    }
    if (!this.outputQueue) return;
    if (!this.hasLiveOutput) {
      this.output.textContent = '';
      this.hasLiveOutput = true;
    }
    appendRichTerminalText(this.output, this.outputQueue, true);
    this.outputQueue = '';
    this.trimOutput();
    this.output.scrollTop = this.output.scrollHeight;
  }

  private trimOutput(): void {
    const text = this.output.textContent ?? '';
    if (text.length <= MAX_OUTPUT_CHARS) return;
    let tail = text.slice(-OUTPUT_TRIM_TARGET);
    const newline = tail.indexOf('\n');
    if (newline >= 0) tail = tail.slice(newline + 1);
    this.output.textContent = '';
    appendRichTerminalText(this.output, `[Older terminal output trimmed for mobile performance]\n${tail}`);
  }

  private renderState(): void {
    const current = this.viewState;
    const displayState = isFinalStatus(current?.status) ? current?.status ?? 'offline' : this.streamState;
    this.shell.dataset.state = displayState;
    this.machine.textContent = current?.agent_name ?? current?.agent_id ?? 'Connecting to computer';
    this.status.dataset.state = displayState;
    const statusLabel = this.status.lastElementChild;
    if (statusLabel) statusLabel.textContent = displayState.toUpperCase();
    this.path.textContent = current?.cwd ?? 'Waiting for terminal session…';
    this.path.title = current?.cwd ?? '';
    this.footerShell.textContent = current?.shell ?? 'shell';
    this.footerStream.textContent = `${this.transportMode.toUpperCase()} ${this.streamState.toUpperCase()}`;
    if (current?.exit_code == null) {
      this.exit.hidden = true;
      this.exit.textContent = '';
      delete this.exit.dataset.success;
    } else {
      this.exit.hidden = false;
      this.exit.textContent = `EXIT ${current.exit_code}`;
      this.exit.dataset.success = current.exit_code === 0 ? 'true' : 'false';
    }
  }

  private callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return this.app.callServerTool({ name, arguments: args });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer === undefined) return;
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private clearReadRetryTimer(): void {
    if (this.readRetryTimer === undefined) return;
    window.clearTimeout(this.readRetryTimer);
    this.readRetryTimer = undefined;
  }
}

function requireElement(doc: Document, id: string): HTMLElement {
  const element = doc.getElementById(id);
  if (!element) throw new Error(`Terminal UI element #${id} is missing.`);
  return element;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getChatGptOpenAiCompat(): ChatGptOpenAiCompat | undefined {
  const value = (window as Window & { openai?: unknown }).openai;
  if (!isRecord(value) || typeof value.callTool !== 'function') return undefined;
  return value as unknown as ChatGptOpenAiCompat;
}

function normalizeCompatCallToolResult(value: unknown): CallToolResult | null {
  return normalizeCallToolResult(value) ?? (isRecord(value) ? { structuredContent: value } : null);
}

function normalizeCallToolResult(value: unknown): CallToolResult | null {
  if (!isRecord(value)) return null;
  let candidate = value;
  if (!hasCallToolResultFields(candidate) && isRecord(candidate.result)) candidate = candidate.result;

  const content = Array.isArray(candidate.content) ? candidate.content : undefined;
  const structuredContent = isRecord(candidate.structuredContent)
    ? candidate.structuredContent
    : isRecord(candidate.structured_content)
      ? candidate.structured_content
      : undefined;
  const meta = isRecord(candidate._meta) ? candidate._meta : undefined;
  const isError = typeof candidate.isError === 'boolean'
    ? candidate.isError
    : typeof candidate.is_error === 'boolean'
      ? candidate.is_error
      : undefined;

  if (!content && !structuredContent && !meta && isError === undefined) return null;
  return {
    ...(content ? { content } : {}),
    ...(structuredContent ? { structuredContent } : {}),
    ...(meta ? { _meta: meta } : {}),
    ...(isError !== undefined ? { isError } : {}),
  };
}

function hasCallToolResultFields(value: Record<string, unknown>): boolean {
  return 'content' in value || 'structuredContent' in value || 'structured_content' in value || '_meta' in value || 'isError' in value || 'is_error' in value;
}

function firstTextContent(result: CallToolResult): string | undefined {
  for (const item of result.content ?? []) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') return item.text;
  }
  return undefined;
}

function structuredPayload(result: CallToolResult): Record<string, unknown> | null {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const text = firstTextContent(result);
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function bootTerminalApp(): Promise<TerminalViewer> {
  const bridge = new ChatGptMcpBridge();
  const viewer = new TerminalViewer(bridge);
  viewer.bind();
  try {
    await bridge.connect();
    viewer.markBridgeReady();
  } catch (error) {
    console.error('[terminal-app] bridge connection failed', error);
    viewer.showBridgeFailure(error);
  }
  return viewer;
}

if (document.querySelector('[data-terminal-static-shell]')) {
  void bootTerminalApp();
}
