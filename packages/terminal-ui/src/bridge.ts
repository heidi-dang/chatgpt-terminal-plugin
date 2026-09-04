import {
  errorMessage,
  isRecord,
  normalizeCallToolResult,
  normalizeCompatCallToolResult,
  type CallToolResult,
  type JsonRpcId,
} from './protocol.js';

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

const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
const BRIDGE_REQUEST_TIMEOUT_MS = 15_000;

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
    this.listening = true;
    window.addEventListener('openai:set_globals', this.handleOpenAiGlobals as EventListener);
    const openAi = getChatGptOpenAiCompat();
    if (openAi) {
      this.openAi = openAi;
      const initial = normalizeCompatCallToolResult(openAi.toolOutput);
      if (initial) this.ontoolresult?.(initial);
      if (typeof openAi.theme === 'string') this.onhostcontextchanged?.({ theme: openAi.theme });
      this.startAutoResize();
      return;
    }

    window.addEventListener('message', this.handleMessage);
    try {
      const initialized = await this.request('ui/initialize', {
        appInfo: { name: 'ChatGPT Terminal', version: '0.13.0' },
        appCapabilities: {},
        protocolVersion: MCP_APPS_PROTOCOL_VERSION,
      });
      if (this.openAi) return;
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
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP App bridge closed.'));
    }
    this.pending.clear();
    return Promise.resolve();
  }

  private readonly handleOpenAiGlobals = (event: CustomEvent<unknown>): void => {
    const openAi = getChatGptOpenAiCompat();
    if (!this.openAi && openAi) {
      this.openAi = openAi;
      this.done(1, {});
    }
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
      this.done(message.id, message.result, isRecord(message.error)
        ? new Error(typeof message.error.message === 'string' ? message.error.message : 'MCP App request failed.')
        : undefined);
      return;
    }

    if (typeof message.method !== 'string') return;
    if ('id' in message && (typeof message.id === 'number' || typeof message.id === 'string')) {
      void this.handleRequest(message.id, message.method);
      return;
    }
    this.handleNotification(message.method, isRecord(message.params) ? message.params : {});
  };

  private done(id: number, result: unknown, error?: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'ui/notifications/tool-result') {
      const result = normalizeCallToolResult(params);
      if (result) this.ontoolresult?.(result);
      return;
    }
    if (method === 'ui/notifications/host-context-changed') this.onhostcontextchanged?.(params);
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

function getChatGptOpenAiCompat(): ChatGptOpenAiCompat | undefined {
  const value = (window as Window & { openai?: unknown }).openai;
  if (!isRecord(value) || typeof value.callTool !== 'function') return undefined;
  return value as unknown as ChatGptOpenAiCompat;
}