import {
  classifySequence,
  errorMessage,
  isFinalStatus,
  mergeViewState,
  parseTerminalEvent,
  parseTerminalReadResult,
  parseStreamMeta,
  parseViewState,
  terminalErrorCode,
  type CallToolResult,
  type TerminalEvent,
  type TerminalStreamMeta,
  type TerminalViewState,
  type StreamState,
} from './protocol.js';
import type { TerminalAppBridge } from './bridge.js';

export type TransportMode = 'sse' | 'mcp';

export interface StreamControllerHost {
  getViewState(): TerminalViewState | null;
  getCursor(): number;
  setCursor(cursor: number): void;
  updateViewState(state: TerminalViewState): void;
  patchViewState(patch: Partial<TerminalViewState>): void;
  queueOutput(text: string): void;
  flushOutput(): void;
  renderState(): void;
  setTransportState(mode: TransportMode, state: StreamState): void;
}

type TerminalEventSource = EventSource & { t?: number };

const STREAM_REFRESH_MARGIN_MS = 15_000;
const SSE_CONNECT_TIMEOUT_MS = 2_000;

export class TerminalStreamController {
  private eventSource: TerminalEventSource | undefined;
  private refreshId = 0;
  private refreshing = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | undefined;
  private readRetryTimer: number | undefined;
  private readFallbackGeneration = 0;
  private readFallbackActive = false;
  private transportMode: TransportMode = 'sse';
  private destroyed = false;

  constructor(
    private readonly app: TerminalAppBridge,
    private readonly host: StreamControllerHost,
  ) {}

  get mode(): TransportMode {
    return this.transportMode;
  }

  reset(cursor: number): void {
    this.refreshId += 1;
    this.refreshing = false;
    closeTerminalSource(this.eventSource);
    this.eventSource = undefined;
    this.clearReconnectTimer();
    this.stopReadFallback();
    this.transportMode = 'sse';
    this.host.setCursor(cursor);
    this.reconnectAttempt = 0;
  }

  start(meta: TerminalStreamMeta): void {
    if (this.destroyed) return;
    const ttl = Date.parse(meta.expires_at) - Date.now();
    if (ttl <= STREAM_REFRESH_MARGIN_MS) {
      this.refreshStream(true);
      return;
    }
    this.connect(meta);
  }

  requestRefresh(retryOnFailure: boolean): void {
    this.refreshStream(retryOnFailure);
  }

  finish(): void {
    this.refreshId += 1;
    this.refreshing = false;
    closeTerminalSource(this.eventSource);
    this.eventSource = undefined;
    this.clearReconnectTimer();
    this.stopReadFallback();
    this.setTransportState(this.transportMode, 'offline');
  }

  destroy(): void {
    this.destroyed = true;
    this.finish();
  }

  private connect(meta: TerminalStreamMeta): void {
    closeTerminalSource(this.eventSource);
    const current = this.host.getViewState();
    if (!current || isFinalStatus(current.status)) return;
    if (!this.readFallbackActive) this.setTransportState('sse', 'connecting');
    const source = new EventSource(meta.url) as TerminalEventSource;
    this.eventSource = source;
    source.t = window.setTimeout(() => {
      if (this.eventSource !== source || isFinalStatus(this.host.getViewState()?.status)) return;
      closeTerminalSource(source);
      this.eventSource = undefined;
      this.startReadFallback();
      this.scheduleStreamReconnect();
    }, SSE_CONNECT_TIMEOUT_MS);

    source.onopen = () => {
      if (this.eventSource !== source) return;
      clearTimeout(source.t);
      this.stopReadFallback();
      this.transportMode = 'sse';
      this.reconnectAttempt = 0;
      this.setTransportState('sse', 'live');
    };
    source.onerror = () => {
      if (this.eventSource !== source || isFinalStatus(this.host.getViewState()?.status)) return;
      closeTerminalSource(source);
      this.eventSource = undefined;
      this.startReadFallback();
      this.scheduleStreamReconnect();
    };
    source.onmessage = (message) => {
      if (this.eventSource !== source) return;
      try {
        if (typeof message.data !== 'string') throw new Error('Terminal SSE message data must be a string.');
        this.acceptEvent(parseTerminalEvent(message.data), source);
      } catch (error) {
        console.error('[terminal-app] invalid SSE event', error);
        closeTerminalSource(source);
        if (this.eventSource === source) this.eventSource = undefined;
        this.startReadFallback();
        this.scheduleStreamReconnect();
      }
    };
  }

  private acceptEvent(event: TerminalEvent, source?: EventSource): 'accepted' | 'stale' | 'gap' {
    const sequenceState = classifySequence(this.host.getCursor(), event.sequence);
    if (sequenceState === 'stale') return 'stale';
    if (sequenceState === 'gap') {
      console.error('[terminal-app] terminal sequence gap', { expected: this.host.getCursor() + 1, received: event.sequence });
      if (source) {
        closeTerminalSource(source);
        if (this.eventSource === source) this.eventSource = undefined;
        this.setTransportState('sse', 'reconnecting');
        this.refreshStream(true);
      }
      return 'gap';
    }
    this.host.setCursor(event.sequence);
    if (event.event_type === 'terminal.stdout' || event.event_type === 'terminal.stderr') {
      if (typeof event.data.text === 'string') this.host.queueOutput(event.data.text);
      return 'accepted';
    }
    if (event.event_type === 'cwd.changed' && typeof event.data.cwd === 'string') {
      this.host.patchViewState({ cwd: event.data.cwd });
      this.host.renderState();
      return 'accepted';
    }
    if ((event.event_type === 'process.exit' || event.event_type === 'session.closed')) {
      const exitCode = typeof event.data.exit_code === 'number' ? event.data.exit_code : undefined;
      this.host.patchViewState({
        status: event.event_type === 'process.exit' ? 'exited' : 'closed',
        ...(exitCode === undefined ? {} : { exit_code: exitCode }),
      });
      this.host.flushOutput();
      this.finish();
      this.host.renderState();
    }
    return 'accepted';
  }

  private startReadFallback(): void {
    const current = this.host.getViewState();
    if (this.readFallbackActive || !current || isFinalStatus(current.status)) return;
    this.clearReadRetryTimer();
    this.readFallbackActive = true;
    const generation = ++this.readFallbackGeneration;
    this.transportMode = 'mcp';
    this.setTransportState('mcp', 'connecting');
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
        const current = this.host.getViewState();
        if (!current || isFinalStatus(current.status)) return;
        const result = await this.callTool('terminal_read', {
          session_id: current.session_id,
          after: this.host.getCursor(),
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
        } else if (read.next_cursor > this.host.getCursor()) {
          if (read.output) this.host.queueOutput(read.output);
          this.host.setCursor(read.next_cursor);
        }
        if (sequenceGap) {
          await this.resynchronizeCursor(current.session_id);
          continue;
        }

        this.transportMode = 'mcp';
        this.setTransportState('mcp', 'live');
        if (this.host.getViewState()?.session_id === current.session_id) {
          this.host.patchViewState({ status: read.status, exit_code: read.exit_code });
          if (isFinalStatus(read.status)) {
            this.host.flushOutput();
            this.finish();
            this.host.renderState();
            return;
          }
        }
      }
    } catch (error) {
      if (!this.readFallbackActive || generation !== this.readFallbackGeneration) return;
      console.error('[terminal-app] MCP read fallback failed', error);
      this.readFallbackActive = false;
      this.readFallbackGeneration += 1;
      this.transportMode = 'sse';
      this.setTransportState('sse', 'reconnecting');
      this.readRetryTimer = window.setTimeout(() => {
        this.readRetryTimer = undefined;
        this.startReadFallback();
      }, 1_000);
    }
  }

  private async resynchronizeCursor(sessionId: string): Promise<void> {
    const statusResult = await this.callTool('terminal_status', { session_id: sessionId });
    if (this.host.getViewState()?.session_id !== sessionId) return;
    const status = parseViewState(statusResult);
    if (statusResult.isError || !status) throw new Error('Unable to resynchronize terminal cursor.');
    if (status.cursor > this.host.getCursor()) this.host.queueOutput('\n[Live output gap: older terminal output was no longer retained]\n');
    this.host.setCursor(status.cursor);
    this.host.updateViewState(mergeViewState(this.host.getViewState(), status));
    this.host.renderState();
  }

  private scheduleStreamReconnect(): void {
    if (this.destroyed || !this.host.getViewState() || isFinalStatus(this.host.getViewState()?.status) || this.reconnectTimer !== undefined) return;
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
    const current = this.host.getViewState();
    if (this.destroyed || !current || isFinalStatus(current.status) || this.refreshing) return;
    const sessionId = current.session_id;
    const refreshId = ++this.refreshId;
    const stale = () => refreshId !== this.refreshId || this.destroyed || this.host.getViewState()?.session_id !== sessionId;
    this.clearReconnectTimer();
    this.refreshing = true;
    if (!this.readFallbackActive) this.setTransportState('sse', 'reconnecting');
    void this.callTool('terminal_stream_refresh', {
      session_id: sessionId,
      after: this.host.getCursor(),
    }).then(async (result) => {
      if (stale()) return;
      if (result.isError && terminalErrorCode(result) === 'INVALID_CURSOR') {
        await this.resynchronizeCursor(sessionId);
        if (stale()) return;
        result = await this.callTool('terminal_stream_refresh', {
          session_id: sessionId,
          after: this.host.getCursor(),
        });
        if (stale()) return;
      }
      if (result.isError) throw new Error(`Terminal stream refresh failed: ${terminalErrorCode(result) ?? 'unknown error'}`);
      const refreshed = parseStreamMeta(result);
      if (!refreshed) throw new Error('Terminal stream refresh returned no stream capability.');
      this.start(refreshed);
    }).catch((error) => {
      if (stale()) return;
      console.error('[terminal-app] stream refresh failed', errorMessage(error));
      this.startReadFallback();
      if (!this.readFallbackActive) this.setTransportState('sse', 'reconnecting');
      if (retryOnFailure) this.scheduleStreamReconnect();
    }).finally(() => {
      if (!stale()) this.refreshing = false;
    });
  }

  private setTransportState(mode: TransportMode, state: StreamState): void {
    this.transportMode = mode;
    this.host.setTransportState(mode, state);
  }

  private callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return this.app.callServerTool({ name, arguments: args });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearReadRetryTimer(): void {
    if (this.readRetryTimer === undefined) return;
    clearTimeout(this.readRetryTimer);
    this.readRetryTimer = undefined;
  }
}

function closeTerminalSource(source?: TerminalEventSource): void {
  if (!source) return;
  clearTimeout(source.t);
  source.close();
}