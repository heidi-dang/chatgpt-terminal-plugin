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

interface TerminalStreamMeta {
  url: string;
  expires_at: string;
}

interface TerminalEvent {
  sequence: number;
  event_type: string;
  data: Record<string, unknown>;
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

type JsonRpcId = number | string;
type StreamState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'failed';

const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
const MAX_OUTPUT_CHARS = 600_000;
const OUTPUT_TRIM_TARGET = 450_000;
const STREAM_REFRESH_MARGIN_MS = 15_000;
const BRIDGE_REQUEST_TIMEOUT_MS = 15_000;

export class ChatGptMcpBridge implements TerminalAppBridge {
  ontoolresult: ((result: CallToolResult) => void) | undefined;
  onhostcontextchanged: ((context: Record<string, unknown>) => void) | undefined;
  onteardown: (() => Promise<Record<string, never>>) | undefined;
  onerror: ((error: Error) => void) | undefined;

  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private listening = false;
  private resizeObserver: ResizeObserver | undefined;
  private resizeFrame: number | undefined;
  private lastReportedHeight = 0;

  async connect(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('message', this.handleMessage);
    try {
      const initialized = await this.request('ui/initialize', {
        appInfo: { name: 'ChatGPT Terminal', version: '0.6.0' },
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
    return this.request('tools/call', params).then((result) => {
      if (!isCallToolResult(result)) throw new Error('Host returned an invalid tools/call result.');
      return result;
    });
  }

  close(): Promise<void> {
    if (!this.listening) return Promise.resolve();
    this.listening = false;
    window.removeEventListener('message', this.handleMessage);
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
      if (isCallToolResult(params)) this.ontoolresult?.(params);
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
  if (!result?.structuredContent || typeof result.structuredContent !== 'object') return null;
  const value = result.structuredContent;
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

function parseTerminalEvent(raw: string): TerminalEvent {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error('Terminal SSE event must be an object.');
  const sequence = parsed.sequence;
  const eventType = parsed.event_type;
  const data = parsed.data;
  if (!Number.isInteger(sequence) || typeof sequence !== 'number' || sequence <= 0) throw new Error('Terminal SSE event has an invalid sequence.');
  if (typeof eventType !== 'string') throw new Error('Terminal SSE event has an invalid event type.');
  if (!isRecord(data)) throw new Error('Terminal SSE event has invalid data.');
  return { sequence, event_type: eventType, data };
}

function isFinalStatus(status: string | undefined): boolean {
  return status === 'closed' || status === 'exited' || status === 'failed';
}

function terminalErrorCode(result: CallToolResult): string | undefined {
  const terminalError = result._meta?.terminal_error;
  if (!isRecord(terminalError)) return undefined;
  return typeof terminalError.code === 'string' ? terminalError.code : undefined;
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
  private outputFrame: number | undefined;
  private outputQueue = '';
  private hasLiveOutput = false;
  private hotReloadVersion: string | undefined;

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
    this.app.onteardown = () => {
      this.destroy();
      return Promise.resolve({});
    };
    this.app.onerror = (error) => {
      console.error('[terminal-app]', error);
      this.showBridgeFailure(error);
    };
  }

  markBridgeReady(): void {
    this.shell.dataset.bridge = 'ready';
  }

  showBridgeFailure(error: unknown): void {
    this.streamState = 'failed';
    this.shell.dataset.bridge = 'failed';
    this.renderState();
    this.queueOutput(`\n[Terminal UI bridge failed: ${errorMessage(error)}]\n`);
  }

  applyToolResult(result: CallToolResult): void {
    const next = parseViewState(result);
    if (next) {
      const previousSession = this.viewState?.session_id;
      this.viewState = mergeViewState(this.viewState, next);
      if (previousSession !== next.session_id) {
        this.lastSequence = next.cursor;
        this.reconnectAttempt = 0;
        this.hasLiveOutput = false;
        this.output.textContent = '';
        if (next.initial_output) this.queueOutput(next.initial_output);
      } else if (next.cursor > this.lastSequence && !isFinalStatus(next.status)) {
        this.lastSequence = next.cursor;
      }
      this.renderState();
    }

    const meta = parseStreamMeta(result);
    if (meta) this.useStream(meta);
    if (this.viewState && isFinalStatus(this.viewState.status)) this.finishStream();
  }

  destroy(): void {
    this.eventSource?.close();
    this.styleSource?.close();
    this.eventSource = undefined;
    this.styleSource = undefined;
    this.clearReconnectTimer();
    this.clearRefreshTimer();
    this.flushOutput();
  }

  private useStream(meta: TerminalStreamMeta): void {
    this.connectTerminalStream(meta);
    this.connectStyleReload(meta);
    this.scheduleCapabilityRefresh(meta);
  }

  private connectTerminalStream(meta: TerminalStreamMeta): void {
    this.eventSource?.close();
    if (!this.viewState || isFinalStatus(this.viewState.status)) return;
    this.streamState = 'connecting';
    this.renderState();
    const source = new EventSource(meta.url);
    this.eventSource = source;

    source.onopen = () => {
      if (this.eventSource !== source) return;
      this.reconnectAttempt = 0;
      this.streamState = 'live';
      this.renderState();
    };
    source.onerror = () => {
      if (this.eventSource !== source || isFinalStatus(this.viewState?.status)) return;
      source.close();
      this.eventSource = undefined;
      this.streamState = 'reconnecting';
      this.renderState();
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

  private acceptEvent(event: TerminalEvent, source: EventSource): void {
    const sequenceState = classifySequence(this.lastSequence, event.sequence);
    if (sequenceState === 'stale') return;
    if (sequenceState === 'gap') {
      console.error('[terminal-app] SSE sequence gap', { expected: this.lastSequence + 1, received: event.sequence });
      source.close();
      if (this.eventSource === source) this.eventSource = undefined;
      this.streamState = 'reconnecting';
      this.renderState();
      this.refreshStream(true);
      return;
    }
    this.lastSequence = event.sequence;
    if (event.event_type === 'terminal.stdout' || event.event_type === 'terminal.stderr') {
      const text = event.data.text;
      if (typeof text === 'string') this.queueOutput(text);
      return;
    }
    if (event.event_type === 'cwd.changed' && typeof event.data.cwd === 'string' && this.viewState) {
      this.viewState = { ...this.viewState, cwd: event.data.cwd };
      this.renderState();
      return;
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
  }

  private finishStream(): void {
    this.eventSource?.close();
    this.eventSource = undefined;
    this.clearReconnectTimer();
    this.clearRefreshTimer();
    this.streamState = 'offline';
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
    this.streamState = 'reconnecting';
    this.renderState();
    void this.callTool('terminal_stream_refresh', {
      session_id: current.session_id,
      after: this.lastSequence,
    }).then(async (result) => {
      if (result.isError && terminalErrorCode(result) === 'INVALID_CURSOR') {
        const statusResult = await this.callTool('terminal_status', { session_id: current.session_id });
        const status = parseViewState(statusResult);
        if (statusResult.isError || !status) throw new Error('Unable to resynchronize terminal cursor.');
        if (status.cursor > this.lastSequence) this.queueOutput('\n[Live output gap: older terminal output was no longer retained]\n');
        this.lastSequence = status.cursor;
        this.viewState = mergeViewState(this.viewState, status);
        this.renderState();
        result = await this.callTool('terminal_stream_refresh', {
          session_id: current.session_id,
          after: this.lastSequence,
        });
      }
      if (result.isError) throw new Error(`Terminal stream refresh failed: ${terminalErrorCode(result) ?? 'unknown error'}`);
      const refreshed = parseStreamMeta(result);
      if (!refreshed) throw new Error('Terminal stream refresh returned no stream capability.');
      this.reconnectAttempt = 0;
      this.useStream(refreshed);
    }).catch((error) => {
      console.error('[terminal-app] stream refresh failed', error);
      this.streamState = 'reconnecting';
      this.renderState();
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
    const normalized = normalizeTerminalText(text);
    if (!normalized) return;
    this.outputQueue += normalized;
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
    this.output.appendChild(this.doc.createTextNode(this.outputQueue));
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
    this.output.textContent = `[Older terminal output trimmed for mobile performance]\n${tail}`;
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
    this.footerStream.textContent = `SSE ${this.streamState.toUpperCase()}`;
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
}

function requireElement(doc: Document, id: string): HTMLElement {
  const element = doc.getElementById(id);
  if (!element) throw new Error(`Terminal UI element #${id} is missing.`);
  return element;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isCallToolResult(value: unknown): value is CallToolResult {
  if (!isRecord(value)) return false;
  if ('structuredContent' in value && value.structuredContent !== undefined && !isRecord(value.structuredContent)) return false;
  if ('_meta' in value && value._meta !== undefined && !isRecord(value._meta)) return false;
  if ('isError' in value && value.isError !== undefined && typeof value.isError !== 'boolean') return false;
  return true;
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

if (window.parent !== window && document.querySelector('[data-terminal-static-shell]')) {
  void bootTerminalApp();
}
