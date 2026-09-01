import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import {
  TerminalProtocolError,
  agentCommandSchema,
  gatewayAuthChallengeSchema,
  gatewayMessageSchema,
  type AgentCommand,
  type GatewayMessage,
  type TerminalEvent,
} from '@terminal/protocol';
import type { TerminalAgentApi } from './index.js';
import type { DeviceIdentity } from './device-identity.js';

export interface GatewayClientOptions {
  url: string;
  identity: DeviceIdentity;
  heartbeatMs: number;
  reconnectMaxMs: number;
  outboundHighWaterBytes: number;
  maxInflightEvents?: number;
}

interface QueuedMessage {
  payload: string;
  bytes: number;
}

export class AgentGatewayClient {
  private socket?: WebSocket;
  private stopped = false;
  private authenticated = false;
  private reconnectAttempt = 0;
  private reconnectAbort: AbortController | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly queue: QueuedMessage[] = [];
  private queuedBytes = 0;
  private unsubscribeEvent: (() => void) | undefined;
  private readonly ackedSequence = new Map<string, number>();
  private readonly sentSequence = new Map<string, number>();
  private readonly pumping = new Set<string>();

  constructor(
    private readonly agent: TerminalAgentApi,
    private readonly options: GatewayClientOptions,
  ) {}
  async start(): Promise<void> {
    this.stopped = false;
    this.unsubscribeEvent ??= this.agent.onEvent((event) => {
      try {
        this.pumpSession(event.session_id);
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', event: 'agent.event_pump_failed', error: errorMessage(error) }));
      }
    });
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.reconnectAttempt = 0;
        await this.waitUntilClosed();
      } catch (error) {
        if (this.stopped) break;
        this.authenticated = false;
        // Exponential backoff with ±25% jitter to prevent thundering herd on mass reconnect
        const base = Math.min(1000 * 2 ** this.reconnectAttempt, this.options.reconnectMaxMs);
        const jitter = base * 0.25 * (2 * Math.random() - 1);
        const floor = Math.min(500, this.options.reconnectMaxMs);
        const backoff = Math.min(this.options.reconnectMaxMs, Math.max(floor, Math.round(base + jitter)));
        this.reconnectAttempt += 1;
        console.error(JSON.stringify({ level: 'warn', event: 'agent.gateway_disconnected', error: errorMessage(error), retry_ms: backoff }));
        const reconnectAbort = new AbortController();
        this.reconnectAbort = reconnectAbort;
        try {
          await delay(backoff, undefined, { signal: reconnectAbort.signal });
        } catch (delayError) {
          if (!this.stopped) throw delayError;
        } finally {
          if (this.reconnectAbort === reconnectAbort) this.reconnectAbort = undefined;
        }
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.authenticated = false;
    this.clearHeartbeat();
    this.reconnectAbort?.abort();
    this.unsubscribeEvent?.();
    this.unsubscribeEvent = undefined;
    this.socket?.close(1000, 'agent stopping');
    this.agent.shutdown();
  }

  private async connectOnce(): Promise<void> {
    const socket = new WebSocket(this.options.url, {
      headers: {
        'x-terminal-device-id': this.options.identity.deviceId,
      },
    });
    this.socket = socket;
    try {
      await this.authenticateSocket(socket);
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN) socket.close(1008, 'device authentication failed');
      else if (socket.readyState === WebSocket.CONNECTING) {
        socket.once('error', () => undefined);
        socket.terminate();
      }
      throw error;
    }
    this.authenticated = true;

    socket.on('message', (data) => {
      try {
        this.handleMessage(rawDataText(data));
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', event: 'agent.gateway_message_failed', error: errorMessage(error) }));
        socket.close(1008, 'invalid gateway message');
      }
    });

    const agent = this.agent.describe();
    this.send({ type: 'agent.register', agent, device_id: this.options.identity.deviceId });
    this.send({ type: 'agent.resume', agent_id: agent.agent_id, sessions: this.agent.listSessionSnapshots() });
    this.flushQueue();
    this.startHeartbeat();
    console.log(JSON.stringify({ level: 'info', event: 'agent.gateway_connected', agent_id: agent.agent_id, device_id: this.options.identity.deviceId }));
  }

  private authenticateSocket(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false;
      let challengeHandled = false;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new TerminalProtocolError('AGENT_TIMEOUT', 'Timed out authenticating the device gateway.', true));
      }, 15_000);
      timeout.unref();

      const onOpen = () => { opened = true; };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new TerminalProtocolError('AGENT_OFFLINE', 'Gateway closed during device authentication.', true));
      };
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const message = gatewayMessageSchema.parse(JSON.parse(rawDataText(raw)));
          if (message.type === 'auth.challenge') {
            const challenge = gatewayAuthChallengeSchema.parse(message);
            if (challengeHandled) throw new TerminalProtocolError('PERMISSION_DENIED', 'Duplicate gateway authentication challenge.');
            if (!opened || Date.parse(challenge.expires_at) <= Date.now()) {
              throw new TerminalProtocolError('PERMISSION_DENIED', 'Gateway authentication challenge expired.');
            }
            challengeHandled = true;
            socket.send(JSON.stringify({
              type: 'auth.proof',
              device_id: this.options.identity.deviceId,
              nonce: challenge.nonce,
              issued_at: challenge.issued_at,
              signature: this.options.identity.signChallenge(challenge),
            }));
            return;
          }
          if (message.type === 'auth.accepted') {
            if (!challengeHandled) throw new TerminalProtocolError('PERMISSION_DENIED', 'Gateway accepted authentication without a challenge.');
            cleanup();
            resolve();
          }
        } catch (error) {
          cleanup();
          reject(normalizeError(error));
        }
      };
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off('open', onOpen);
        socket.off('error', onError);
        socket.off('close', onClose);
        socket.off('message', onMessage);
      };

      socket.on('open', onOpen);
      socket.on('error', onError);
      socket.on('close', onClose);
      socket.on('message', onMessage);
    });
  }

  private waitUntilClosed(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      socket.once('close', () => {
        this.authenticated = false;
        this.clearHeartbeat();
        resolve();
      });
    });
  }

  private handleMessage(raw: string): void {
    const message = gatewayMessageSchema.parse(JSON.parse(raw));
    if (message.type === 'ack') {
      const current = this.ackedSequence.get(message.session_id) ?? 0;
      if (message.sequence > current) this.ackedSequence.set(message.session_id, message.sequence);
      if ((this.sentSequence.get(message.session_id) ?? 0) < message.sequence) this.sentSequence.set(message.session_id, message.sequence);
      this.pumpSession(message.session_id);
      return;
    }
    if (message.type === 'agent.resume.ack') {
      for (const snapshot of this.agent.listSessionSnapshots()) {
        const sessionId = snapshot.session.session_id;
        const sequence = message.sequences[sessionId] ?? snapshot.earliestCursor;
        this.ackedSequence.set(sessionId, sequence);
        this.sentSequence.set(sessionId, sequence);
        this.pumpSession(sessionId);
      }
      return;
    }
    if (message.type !== 'request') return;
    const command = agentCommandSchema.parse(message);

    void (async () => {
      try {
        const result = await this.execute(command);
        this.send({ type: 'response', request_id: command.request_id, ok: true, result });
      } catch (error) {
        const protocolError = normalizeProtocolError(error);
        this.send({
          type: 'response',
          request_id: command.request_id,
          ok: false,
          error: protocolError.toPayload(),
        });
      }
    })();
  }

  private async execute(command: AgentCommand): Promise<unknown> {
    switch (command.action) {
      case 'terminal.start':
        return this.agent.start(command.user_id, command.input, command.execution_profile);
      case 'terminal.write':
        return this.agent.write(command.input.session_id, command.input.text);
      case 'terminal.resize':
        return this.agent.resize(command.input.session_id, command.input.cols, command.input.rows);
      case 'terminal.interrupt':
        return this.agent.interrupt(command.input.session_id);
      case 'terminal.close':
        return this.agent.close(command.input.session_id);
      case 'terminal.status':
        return this.agent.status(command.input.session_id);
      case 'file.read':
        return this.agent.readFile(command.input.session_id, command.input.path, command.input.max_bytes);
      case 'file.list':
        return this.agent.listFiles(command.input.session_id, command.input.path, command.input.max_entries);
      case 'file.write':
        return this.agent.writeFile(command.input.session_id, command.input.path, command.input.content, command.input.create_directories);
      case 'file.search':
        return this.agent.searchFiles(command.input.session_id, command.input.pattern, command.input.path, command.input.include, command.input.max_results, command.input.context_lines);
      case 'code.execute':
        return this.agent.executeCode(command.user_id, command.input, command.execution_profile);
      case 'code.cancel':
        return this.agent.cancelCode(command.user_id, command.input.execution_id, command.execution_profile);
      case 'lsp.start':
        return this.agent.startLsp(command.user_id, command.input, command.execution_profile);
      case 'lsp.request':
        return this.agent.requestLsp(command.user_id, command.input, command.execution_profile);
      case 'lsp.stop':
        return this.agent.stopLsp(command.user_id, command.input.lsp_id, command.execution_profile);
    }
  }

  private pumpSession(sessionId: string): void {
    const socket = this.socket;
    if (!this.authenticated || !socket || socket.readyState !== WebSocket.OPEN || this.pumping.has(sessionId)) return;
    this.pumping.add(sessionId);
    try {
      const maxInflight = this.options.maxInflightEvents ?? 128;
      let acked = this.ackedSequence.get(sessionId) ?? 0;
      let sent = this.sentSequence.get(sessionId) ?? acked;
      if (sent < acked) sent = acked;

      while (sent - acked < maxInflight) {
        const remaining = maxInflight - (sent - acked);
        let read;
        try {
          read = this.agent.readEvents(sessionId, sent, this.options.outboundHighWaterBytes);
        } catch (error) {
          if (error instanceof TerminalProtocolError && error.code === 'SESSION_NOT_FOUND') return;
          throw error;
        }
        if (read.events.length === 0) return;
        for (const event of read.events.slice(0, remaining)) {
          socket.send(JSON.stringify({ type: 'event', event } satisfies GatewayMessage));
          sent = event.sequence;
          this.sentSequence.set(sessionId, sent);
        }
        acked = this.ackedSequence.get(sessionId) ?? acked;
        if (!read.hasMore || sent - acked >= maxInflight) return;
      }
    } finally {
      this.pumping.delete(sessionId);
    }
  }

  private send(message: GatewayMessage): void {
    const payload = JSON.stringify(message);
    const bytes = Buffer.byteLength(payload);
    if (bytes > this.options.outboundHighWaterBytes) {
      throw new TerminalProtocolError('OUTPUT_LIMIT_REACHED', 'Outbound gateway message exceeds the configured high-water mark.');
    }

    const socket = this.socket;
    if (this.authenticated && socket?.readyState === WebSocket.OPEN) {
      socket.send(payload);
      return;
    }
    this.enqueue(payload, bytes);
  }

  private enqueue(payload: string, bytes: number): void {
    if (this.queuedBytes + bytes > this.options.outboundHighWaterBytes) {
      throw new TerminalProtocolError('OUTPUT_LIMIT_REACHED', 'Outbound control-message buffer reached its configured high-water mark.');
    }
    this.queue.push({ payload, bytes });
    this.queuedBytes += bytes;
  }

  private flushQueue(): void {
    const socket = this.socket;
    if (!this.authenticated || !socket || socket.readyState !== WebSocket.OPEN) return;
    let sentCount = 0;
    try {
      for (; sentCount < this.queue.length; sentCount += 1) {
        const item = this.queue[sentCount];
        if (!item) break;
        this.queuedBytes -= item.bytes;
        socket.send(item.payload);
      }
    } finally {
      if (sentCount > 0) this.queue.splice(0, sentCount);
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      this.send({ type: 'heartbeat', timestamp: new Date().toISOString() });
    }, this.options.heartbeatMs);
    this.heartbeat.unref();
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

function normalizeProtocolError(error: unknown): TerminalProtocolError {
  if (error instanceof TerminalProtocolError) return error;
  return new TerminalProtocolError('INVALID_ARGUMENT', errorMessage(error));
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

function rawDataText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function terminalTextFromEvent(event: TerminalEvent): string {
  if (event.event_type !== 'terminal.stdout' && event.event_type !== 'terminal.stderr') return '';
  return typeof event.data.text === 'string' ? event.data.text : '';
}
