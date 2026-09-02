import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  TerminalProtocolError,
  agentResponseSchema,
  agentSessionSnapshotSchema,
  gatewayAuthProofSchema,
  gatewayChallengePayload,
  gatewayMessageSchema,
  codeCancelOutputSchema,
  codeExecuteOutputSchema,
  lspRequestOutputSchema,
  lspStartOutputSchema,
  lspStopOutputSchema,
  terminalListFilesOutputSchema,
  terminalReadFileOutputSchema,
  terminalReadOutputSchema,
  terminalSearchFilesOutputSchema,
  terminalWriteFileOutputSchema,
  terminalDeleteFileOutputSchema,
  terminalRenameFileOutputSchema,
  type Agent,
  type CodeCancelOutput,
  type CodeExecuteOutput,
  type AgentCommand,
  type ExecutionProfile,
  type LspRequestOutput,
  type LspStartOutput,
  type LspStopOutput,
  type TerminalExecuteCodeBlockToolArgs,
  type TerminalLspRequestArgs,
  type TerminalLspStartArgs,
  type TerminalLspStopArgs,
  type AgentSessionSnapshot,
  type TerminalEvent,
  type TerminalListFilesOutput,
  type TerminalReadFileOutput,
  type TerminalReadOutput,
  type TerminalSearchFilesOutput,
  type TerminalWriteFileOutput,
  type TerminalDeleteFileOutput,
  type TerminalRenameFileOutput,
  type TerminalSession,
  type TerminalStartInput,
} from '@terminal/protocol';
import type { DeviceRegistry } from './device-registry.js';

interface AgentConnection {
  agent: Agent;
  deviceId: string;
  ownerId: string;
  socket: WebSocket;
  lastSeenMs: number;
}

interface PendingRequest {
  agentId: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  parseResult?: ((raw: unknown) => unknown) | undefined;
}

export interface SessionRecord {
  ownerId?: string;
  agentId?: string;
  session?: TerminalSession;
  events: TerminalEvent[];
  eventSizes: number[];
  eventHead: number;
  latestSequence: number;
  earliestSequence: number;
  retainedBytes: number;
  // Session metrics — monotonically increasing counters
  totalEvents: number;
  totalOutputBytes: number;
  commandCount: number;
}

export interface AgentGatewayOptions {
  requestTimeoutMs: number;
  maxRetainedBytesPerSession: number;
  closedSessionRetentionMs: number;
  sessionSweepIntervalMs: number;
  deviceRegistry: DeviceRegistry;
  authChallengeTtlMs: number;
  onTerminalEvent?: (ownerId: string, agentId: string, event: TerminalEvent) => void | Promise<void>;
}

export class AgentGateway {
  // Limit individual WebSocket message size to prevent memory exhaustion from oversized payloads.
  // Terminal events rarely exceed a few KB; 2 MB provides generous headroom while bounding risk.
  readonly webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  private readonly agents = new Map<string, AgentConnection>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly eventEmitter = new EventEmitter().setMaxListeners(0);
  private readonly usedAuthNonces = new Map<string, number>();
  private readonly sessionSweepTimer: NodeJS.Timeout;

  constructor(private readonly options: AgentGatewayOptions) {
    this.webSocketServer.on('connection', (socket, request) => this.accept(socket, request));
    this.sessionSweepTimer = setInterval(() => this.sweepRetainedSessions(), options.sessionSweepIntervalMs);
    this.sessionSweepTimer.unref();
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      this.webSocketServer.emit('connection', ws, request);
    });
  }

  listAgents(userId: string): Agent[] {
    return [...this.agents.values()]
      .filter((entry) => entry.ownerId === userId)
      .map((entry) => ({
        ...entry.agent,
        online: entry.socket.readyState === WebSocket.OPEN,
        last_seen: new Date(entry.lastSeenMs).toISOString(),
      }));
  }

  listSessions(userId: string): TerminalSession[] {
    return [...this.sessions.values()]
      .filter((record) => record.ownerId === userId && record.session)
      .map((record) => ({ ...record.session! }));
  }

  activeAgentCount(): number {
    return [...this.agents.values()].filter((entry) => entry.socket.readyState === WebSocket.OPEN).length;
  }

  revokeDevice(deviceId: string): void {
    for (const connection of this.agents.values()) {
      if (connection.deviceId === deviceId) connection.socket.close(1008, 'device revoked');
    }
  }

  async start(userId: string, input: TerminalStartInput, executionProfile: ExecutionProfile): Promise<AgentSessionSnapshot> {
    const connection = this.requireAgent(userId, input.agent_id);
    const snapshot = await this.request(connection, {
      type: 'request',
      request_id: randomUUID(),
      action: 'terminal.start',
      user_id: userId,
      execution_profile: executionProfile,
      input,
    });
    this.assertSnapshotIdentity(connection, snapshot, userId);
    if (!isProfileAtMost(snapshot.session.execution_profile, executionProfile)) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Agent returned a terminal session with a more privileged execution profile than requested.');
    }
    this.upsertSnapshot(snapshot, userId);
    return this.withServerCursor(snapshot);
  }

  async write(userId: string, sessionId: string, text: string): Promise<AgentSessionSnapshot> {
    return this.sessionRequest(userId, sessionId, {
      type: 'request',
      request_id: randomUUID(),
      action: 'terminal.write',
      input: { session_id: sessionId, text },
    });
  }

  async resize(userId: string, sessionId: string, cols: number, rows: number): Promise<AgentSessionSnapshot> {
    return this.sessionRequest(userId, sessionId, {
      type: 'request',
      request_id: randomUUID(),
      action: 'terminal.resize',
      input: { session_id: sessionId, cols, rows },
    });
  }

  async interrupt(userId: string, sessionId: string): Promise<AgentSessionSnapshot> {
    return this.sessionRequest(userId, sessionId, {
      type: 'request',
      request_id: randomUUID(),
      action: 'terminal.interrupt',
      input: { session_id: sessionId },
    });
  }

  async close(userId: string, sessionId: string): Promise<AgentSessionSnapshot> {
    return this.sessionRequest(userId, sessionId, {
      type: 'request',
      request_id: randomUUID(),
      action: 'terminal.close',
      input: { session_id: sessionId },
    });
  }

  async status(userId: string, sessionId: string): Promise<AgentSessionSnapshot> {
    return this.sessionRequest(userId, sessionId, {
      type: 'request',
      request_id: randomUUID(),
      action: 'terminal.status',
      input: { session_id: sessionId },
    });
  }

  getSessionMetrics(userId: string, sessionId: string): { totalEvents: number; totalOutputBytes: number; commandCount: number } | undefined {
    const record = this.sessions.get(sessionId);
    if (!record || (record.ownerId && record.ownerId !== userId)) return undefined;
    return {
      totalEvents: record.totalEvents,
      totalOutputBytes: record.totalOutputBytes,
      commandCount: record.commandCount,
    };
  }

  getTranscript(userId: string, sessionId: string, maxEntries: number, afterSequence: number, includeOutput: boolean): { entries: Array<{ type: string; timestamp: string; text: string }>; next_sequence: number; has_more: boolean } {
    const record = this.requireSession(userId, sessionId);
    const entries: Array<{ type: string; timestamp: string; text: string }> = [];
    let lastSequence = afterSequence;

    for (let i = record.eventHead; i < record.events.length && entries.length < maxEntries; i += 1) {
      const event = record.events[i];
      if (!event || event.sequence <= afterSequence) continue;
      lastSequence = event.sequence;

      switch (event.event_type) {
        case 'command.input':
          entries.push({
            type: 'command',
            timestamp: event.timestamp,
            text: typeof event.data.text === 'string' ? event.data.text : '',
          });
          break;
        case 'terminal.stdout':
        case 'terminal.stderr':
          if (includeOutput) {
            entries.push({
              type: event.event_type === 'terminal.stderr' ? 'error' : 'output',
              timestamp: event.timestamp,
              text: typeof event.data.text === 'string' ? event.data.text.slice(0, 4096) : '',
            });
          }
          break;
        case 'session.started':
        case 'session.closed':
        case 'process.exit':
        case 'cwd.changed':
        case 'agent.connected':
        case 'agent.disconnected':
          entries.push({
            type: 'status',
            timestamp: event.timestamp,
            text: event.event_type + (event.event_type === 'process.exit' && typeof event.data.exit_code === 'number' ? ` (exit ${event.data.exit_code})` : '') + (event.event_type === 'cwd.changed' && typeof event.data.cwd === 'string' ? ` → ${event.data.cwd}` : ''),
          });
          break;
      }
    }

    return {
      entries,
      next_sequence: lastSequence,
      has_more: lastSequence < record.latestSequence,
    };
  }

  // --- File operations ---
  // These dispatch file commands to the agent and return generic results.

  async readFile(userId: string, sessionId: string, path: string, maxBytes: number): Promise<TerminalReadFileOutput> {
    const record = this.requireSession(userId, sessionId);
    if (!record.agentId) throw new TerminalProtocolError('AGENT_OFFLINE', 'Session is not associated with an agent.', true);
    const connection = this.requireAgent(userId, record.agentId);
    return this.request(connection, {
      type: 'request', request_id: randomUUID(), action: 'file.read',
      input: { session_id: sessionId, path, max_bytes: maxBytes },
    }, (raw) => terminalReadFileOutputSchema.parse(raw));
  }

  async listFiles(userId: string, sessionId: string, path: string, maxEntries: number): Promise<TerminalListFilesOutput> {
    const record = this.requireSession(userId, sessionId);
    if (!record.agentId) throw new TerminalProtocolError('AGENT_OFFLINE', 'Session is not associated with an agent.', true);
    const connection = this.requireAgent(userId, record.agentId);
    return this.request(connection, {
      type: 'request', request_id: randomUUID(), action: 'file.list',
      input: { session_id: sessionId, path, max_entries: maxEntries },
    }, (raw) => terminalListFilesOutputSchema.parse(raw));
  }

  async writeFile(userId: string, sessionId: string, path: string, content: string, createDirectories: boolean): Promise<TerminalWriteFileOutput> {
    const record = this.requireSession(userId, sessionId);
    if (!record.agentId) throw new TerminalProtocolError('AGENT_OFFLINE', 'Session is not associated with an agent.', true);
    const connection = this.requireAgent(userId, record.agentId);
    return this.request(connection, {
      type: 'request', request_id: randomUUID(), action: 'file.write',
      input: { session_id: sessionId, path, content, create_directories: createDirectories },
    }, (raw) => terminalWriteFileOutputSchema.parse(raw));
  }

  async deleteFile(userId: string, sessionId: string, path: string): Promise<TerminalDeleteFileOutput> {
    const record = this.requireSession(userId, sessionId);
    if (!record.agentId) throw new TerminalProtocolError('AGENT_OFFLINE', 'Session is not associated with an agent.', true);
    const connection = this.requireAgent(userId, record.agentId);
    return this.request(connection, {
      type: 'request', request_id: randomUUID(), action: 'file.delete',
      input: { session_id: sessionId, path },
    }, (raw) => terminalDeleteFileOutputSchema.parse(raw));
  }

  async renameFile(userId: string, sessionId: string, fromPath: string, toPath: string): Promise<TerminalRenameFileOutput> {
    const record = this.requireSession(userId, sessionId);
    if (!record.agentId) throw new TerminalProtocolError('AGENT_OFFLINE', 'Session is not associated with an agent.', true);
    const connection = this.requireAgent(userId, record.agentId);
    return this.request(connection, {
      type: 'request', request_id: randomUUID(), action: 'file.rename',
      input: { session_id: sessionId, from_path: fromPath, to_path: toPath },
    }, (raw) => terminalRenameFileOutputSchema.parse(raw));
  }

  async searchFiles(userId: string, sessionId: string, pattern: string, path: string, include: string | undefined, maxResults: number, contextLines: number): Promise<TerminalSearchFilesOutput> {
    const record = this.requireSession(userId, sessionId);
    if (!record.agentId) throw new TerminalProtocolError('AGENT_OFFLINE', 'Session is not associated with an agent.', true);
    const connection = this.requireAgent(userId, record.agentId);
    const input = {
      session_id: sessionId,
      pattern,
      path,
      max_results: maxResults,
      context_lines: contextLines,
      ...(include === undefined ? {} : { include }),
    };
    return this.request(connection, {
      type: 'request', request_id: randomUUID(), action: 'file.search', input,
    }, (raw) => terminalSearchFilesOutputSchema.parse(raw));
  }

  async executeCode(userId: string, input: TerminalExecuteCodeBlockToolArgs, executionProfile: ExecutionProfile): Promise<CodeExecuteOutput> {
    const connection = this.requireAgent(userId, input.agent_id);
    const executionId = input.execution_id ?? randomUUID();
    const agentInput = {
      execution_id: executionId,
      runtime: input.runtime,
      code: input.code,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.timeout_ms === undefined ? {} : { timeout_ms: input.timeout_ms }),
    };
    const timeoutMs = Math.max(this.options.requestTimeoutMs, Math.min(input.timeout_ms ?? 10_000, 120_000) + 2_000);
    return this.request(connection, {
      type: 'request', request_id: randomUUID(), action: 'code.execute', user_id: userId,
      execution_profile: executionProfile, input: agentInput,
    }, (raw) => codeExecuteOutputSchema.parse(raw), timeoutMs);
  }

  async cancelCode(userId: string, agentId: string, executionId: string, executionProfile: ExecutionProfile): Promise<CodeCancelOutput> {
    const connection = this.requireAgent(userId, agentId);
    return this.request(connection, {
      type: 'request', request_id: randomUUID(), action: 'code.cancel', user_id: userId,
      execution_profile: executionProfile, input: { execution_id: executionId },
    }, (raw) => codeCancelOutputSchema.parse(raw));
  }

  async startLsp(userId: string, input: TerminalLspStartArgs, executionProfile: ExecutionProfile): Promise<LspStartOutput> {
    const connection = this.requireAgent(userId, input.agent_id);
    return this.request(connection, {
      type: 'request', request_id: randomUUID(), action: 'lsp.start', user_id: userId,
      execution_profile: executionProfile, input: { server_id: input.server_id, root: input.root },
    }, (raw) => lspStartOutputSchema.parse(raw));
  }

  async requestLsp(userId: string, input: TerminalLspRequestArgs, executionProfile: ExecutionProfile): Promise<LspRequestOutput> {
    const connection = this.requireAgent(userId, input.agent_id);
    const agentInput = { lsp_id: input.lsp_id, method: input.method, ...(input.notification === undefined ? {} : { notification: input.notification }), ...(input.params === undefined ? {} : { params: input.params }) };
    return this.request(connection, {
      type: 'request', request_id: randomUUID(), action: 'lsp.request', user_id: userId,
      execution_profile: executionProfile, input: agentInput,
    }, (raw) => lspRequestOutputSchema.parse(raw));
  }

  async stopLsp(userId: string, input: TerminalLspStopArgs, executionProfile: ExecutionProfile): Promise<LspStopOutput> {
    const connection = this.requireAgent(userId, input.agent_id);
    return this.request(connection, {
      type: 'request', request_id: randomUUID(), action: 'lsp.stop', user_id: userId,
      execution_profile: executionProfile, input: { lsp_id: input.lsp_id },
    }, (raw) => lspStopOutputSchema.parse(raw));
  }

  async read(userId: string, sessionId: string, after: number, maxBytes: number, waitMs = 0): Promise<TerminalReadOutput> {
    const record = this.requireSession(userId, sessionId);
    this.assertCursor(record, after);

    if (after === record.latestSequence && waitMs > 0 && this.isSessionActive(record.session)) {
      await this.waitForEvent(sessionId, after, waitMs);
    }

    const refreshed = this.requireSession(userId, sessionId);
    this.assertCursor(refreshed, after);
    const events: TerminalEvent[] = [];
    const outputChunks: string[] = [];
    let bytes = 0;
    const startIndex = refreshed.eventHead + Math.max(0, after - refreshed.earliestSequence + 1);

    for (let index = startIndex; index < refreshed.events.length; index += 1) {
      const event = refreshed.events[index];
      const eventBytes = refreshed.eventSizes[index];
      if (!event || eventBytes === undefined) break;
      if (events.length > 0 && bytes + eventBytes > maxBytes) break;
      if (events.length === 0 && eventBytes > maxBytes) {
        throw new TerminalProtocolError('OUTPUT_LIMIT_REACHED', 'A terminal event exceeds the requested MCP read limit.');
      }
      events.push(event);
      if ((event.event_type === 'terminal.stdout' || event.event_type === 'terminal.stderr') && typeof event.data.text === 'string') {
        outputChunks.push(event.data.text);
      }
      bytes += eventBytes;
    }

    const nextCursor = events.at(-1)?.sequence ?? after;
    const output = outputChunks.join('');

    return terminalReadOutputSchema.parse({
      output,
      events,
      next_cursor: nextCursor,
      has_more: nextCursor < refreshed.latestSequence,
      status: refreshed.session?.status ?? 'disconnected',
      exit_code: refreshed.session?.exit_code ?? null,
    });
  }

  getSessionForUser(userId: string, sessionId: string): SessionRecord {
    return this.requireSession(userId, sessionId);
  }

  subscribe(sessionId: string, listener: (event: TerminalEvent) => void): () => void {
    const key = `session:${sessionId}`;
    this.eventEmitter.on(key, listener);
    return () => this.eventEmitter.off(key, listener);
  }

  closeAll(): void {
    clearInterval(this.sessionSweepTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new TerminalProtocolError('AGENT_OFFLINE', 'Gateway is shutting down.', true));
    }
    this.pending.clear();
    for (const connection of this.agents.values()) connection.socket.close(1001, 'gateway shutting down');
    this.agents.clear();
    this.sessions.clear();
    this.eventEmitter.removeAllListeners();
    this.webSocketServer.close();
  }

  private accept(socket: WebSocket, request: IncomingMessage): void {
    const deviceId = headerValue(request, 'x-terminal-device-id');
    if (!deviceId) {
      socket.close(1008, 'missing device identity');
      return;
    }

    let device;
    try {
      device = this.options.deviceRegistry.requireActive(deviceId);
    } catch {
      socket.close(1008, 'device is not enrolled');
      return;
    }

    const issuedAt = new Date().toISOString();
    const nonce = randomUUID();
    const expiresAtMs = Date.now() + this.options.authChallengeTtlMs;
    const expiresAt = new Date(expiresAtMs).toISOString();
    for (const [usedNonce, expiry] of this.usedAuthNonces) {
      if (expiry <= Date.now()) this.usedAuthNonces.delete(usedNonce);
    }

    let authenticated = false;
    let registeredAgentId: string | undefined;
    const ownerId = device.owner_id;
    socket.send(JSON.stringify({ type: 'auth.challenge', nonce, issued_at: issuedAt, expires_at: expiresAt }));

    socket.on('message', (raw) => {
      try {
        const message = gatewayMessageSchema.parse(JSON.parse(rawDataText(raw)));
        if (!authenticated) {
          if (message.type !== 'auth.proof') {
            throw new TerminalProtocolError('PERMISSION_DENIED', 'Device authentication proof is required before gateway use.');
          }
          const proof = gatewayAuthProofSchema.parse(message);
          if (proof.device_id !== deviceId || proof.nonce !== nonce || proof.issued_at !== issuedAt || Date.now() > expiresAtMs) {
            throw new TerminalProtocolError('PERMISSION_DENIED', 'Device authentication challenge mismatch or expiry.');
          }
          if (this.usedAuthNonces.has(nonce)) {
            throw new TerminalProtocolError('PERMISSION_DENIED', 'Device authentication challenge was already used.');
          }
          const verified = this.options.deviceRegistry.verifyProof(
            deviceId,
            gatewayChallengePayload(deviceId, nonce, issuedAt),
            proof.signature,
          );
          if (verified.owner_id !== ownerId) throw new TerminalProtocolError('PERMISSION_DENIED', 'Device owner changed during authentication.');
          this.usedAuthNonces.set(nonce, expiresAtMs);
          authenticated = true;
          void this.options.deviceRegistry.markSeen(deviceId);
          socket.send(JSON.stringify({ type: 'auth.accepted', server_time: new Date().toISOString() }));
          return;
        }

        if (message.type === 'auth.proof' || message.type === 'auth.challenge' || message.type === 'auth.accepted') {
          throw new TerminalProtocolError('PERMISSION_DENIED', 'Unexpected gateway authentication message.');
        }

        if (message.type === 'agent.register') {
          if (message.device_id !== deviceId) {
            throw new TerminalProtocolError('PERMISSION_DENIED', 'Device identity mismatch.');
          }
          if (message.agent.agent_id !== device.agent_id) {
            throw new TerminalProtocolError('PERMISSION_DENIED', 'Agent identity is not bound to the enrolled device.');
          }
          registeredAgentId = message.agent.agent_id;
          const previous = this.agents.get(message.agent.agent_id);
          if (previous && previous.socket !== socket) previous.socket.close(1000, 'agent reconnected');
          this.agents.set(message.agent.agent_id, {
            agent: { ...message.agent, online: true, last_seen: new Date().toISOString() },
            deviceId,
            ownerId,
            socket,
            lastSeenMs: Date.now(),
          });
          return;
        }

        if (!registeredAgentId) {
          throw new TerminalProtocolError('PERMISSION_DENIED', 'Agent must register before sending gateway messages.');
        }

        const connection = this.agents.get(registeredAgentId);
        if (!connection || connection.socket !== socket) {
          throw new TerminalProtocolError('AGENT_OFFLINE', 'Agent connection is no longer active.');
        }
        connection.lastSeenMs = Date.now();
        connection.agent.last_seen = new Date(connection.lastSeenMs).toISOString();

        if (message.type === 'heartbeat' || message.type === 'ack') return;
        if (message.type === 'event') {
          const existing = this.sessions.get(message.event.session_id);
          if (existing?.ownerId && existing.ownerId !== ownerId) {
            throw new TerminalProtocolError('PERMISSION_DENIED', 'Terminal event owner mismatch.');
          }
          this.storeEvent(message.event, registeredAgentId, ownerId);
          void this.options.onTerminalEvent?.(ownerId, registeredAgentId, message.event);
          socket.send(JSON.stringify({ type: 'ack', session_id: message.event.session_id, sequence: message.event.sequence }));
          return;
        }
        if (message.type === 'agent.resume') {
          if (message.agent_id !== registeredAgentId) throw new TerminalProtocolError('PERMISSION_DENIED', 'Agent resume identity mismatch.');
          const sequences: Record<string, number> = {};
          for (const snapshot of message.sessions) {
            const session = snapshot.session;
            if (session.user_id !== ownerId || session.agent_id !== registeredAgentId) {
              throw new TerminalProtocolError('PERMISSION_DENIED', 'Resumed terminal session identity mismatch.');
            }
            if (!isProfileAtMost(session.execution_profile, connection.agent.execution_profile)) {
              throw new TerminalProtocolError('PERMISSION_DENIED', 'Resumed terminal session exceeds the agent execution profile.');
            }
            if (this.isFinalSessionRetentionExpired(session, Date.now())) {
              sequences[session.session_id] = snapshot.cursor;
              this.sessions.delete(session.session_id);
              this.eventEmitter.removeAllListeners(`session:${session.session_id}`);
              continue;
            }
            const existing = this.sessions.get(session.session_id);
            if (existing?.ownerId && existing.ownerId !== ownerId) {
              throw new TerminalProtocolError('PERMISSION_DENIED', 'Resumed terminal session owner mismatch.');
            }
            if (existing && existing.latestSequence > snapshot.cursor) {
              throw new TerminalProtocolError('INVALID_CURSOR', 'Server terminal cursor is ahead of the resumed agent session.');
            }
            const baseCursor = existing?.latestSequence ?? snapshot.earliestCursor;
            const record = existing ?? {
              ownerId,
              agentId: registeredAgentId,
              events: [],
              eventSizes: [],
              eventHead: 0,
              latestSequence: baseCursor,
              earliestSequence: baseCursor + 1,
              retainedBytes: 0,
              totalEvents: 0,
              totalOutputBytes: 0,
              commandCount: 0,
            };
            if (record.latestSequence < snapshot.earliestCursor) {
              record.events = [];
              record.eventSizes = [];
              record.eventHead = 0;
              record.retainedBytes = 0;
              record.latestSequence = snapshot.earliestCursor;
              record.earliestSequence = snapshot.earliestCursor + 1;
            }
            this.sessions.set(session.session_id, record);
            sequences[session.session_id] = record.latestSequence;
            const resumed = { ...session };
            if (resumed.status === 'disconnected') resumed.status = 'running';
            this.upsertSnapshot({ ...snapshot, session: resumed }, ownerId);
          }
          socket.send(JSON.stringify({ type: 'agent.resume.ack', sequences }));
          return;
        }
        if (message.type === 'response') this.resolveResponse(registeredAgentId, message);
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', event: 'gateway.invalid_agent_message', error: errorMessage(error) }));
        socket.close(1008, 'invalid gateway message');
      }
    });

    socket.once('close', () => {
      if (!registeredAgentId) return;
      const current = this.agents.get(registeredAgentId);
      if (current?.socket === socket) {
        current.agent.online = false;
        current.lastSeenMs = Date.now();
        for (const record of this.sessions.values()) {
          if (record.agentId === registeredAgentId && record.session && this.isSessionActive(record.session)) {
            record.session.status = 'disconnected';
          }
        }
      }

      for (const [requestId, pending] of this.pending) {
        if (pending.agentId !== registeredAgentId) continue;
        clearTimeout(pending.timer);
        pending.reject(new TerminalProtocolError('AGENT_OFFLINE', 'Agent disconnected while handling the request.', true));
        this.pending.delete(requestId);
      }
    });
  }

  private async sessionRequest(userId: string, sessionId: string, command: AgentCommand): Promise<AgentSessionSnapshot> {
    const record = this.requireSession(userId, sessionId);
    if (!record.agentId) throw new TerminalProtocolError('AGENT_OFFLINE', 'Session is not associated with an agent.', true);
    const connection = this.requireAgent(userId, record.agentId);
    const snapshot = await this.request(connection, command);
    this.assertSnapshotIdentity(connection, snapshot, userId, sessionId);
    this.upsertSnapshot(snapshot, userId);
    return this.withServerCursor(snapshot);
  }

  private request<T = AgentSessionSnapshot>(
    connection: AgentConnection,
    command: AgentCommand,
    parseResult?: (raw: unknown) => T,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<T> {
    if (connection.socket.readyState !== WebSocket.OPEN) {
      throw new TerminalProtocolError('AGENT_OFFLINE', 'Agent is offline.', true);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.request_id);
        reject(new TerminalProtocolError('AGENT_TIMEOUT', 'Timed out waiting for the local terminal agent.', true));
      }, timeoutMs);
      timer.unref();
      this.pending.set(command.request_id, { agentId: connection.agent.agent_id, resolve: resolve as (result: unknown) => void, reject, timer, parseResult });
      connection.socket.send(JSON.stringify(command), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(command.request_id);
        reject(new TerminalProtocolError('AGENT_OFFLINE', `Failed to send command to agent: ${error.message}`, true));
      });
    });
  }

  private resolveResponse(agentId: string, raw: unknown): void {
    const response = agentResponseSchema.parse(raw);
    const pending = this.pending.get(response.request_id);
    if (!pending || pending.agentId !== agentId) return;
    this.pending.delete(response.request_id);
    clearTimeout(pending.timer);

    if (!response.ok) {
      const error = response.error;
      pending.reject(new TerminalProtocolError(
        error?.code ?? 'INVALID_ARGUMENT',
        error?.message ?? 'Agent request failed.',
        error?.retryable ?? false,
      ));
      return;
    }

    const parsed = pending.parseResult ? pending.parseResult(response.result) : agentSessionSnapshotSchema.parse(response.result);
    pending.resolve(parsed);
  }

  private requireAgent(userId: string, agentId: string): AgentConnection {
    const connection = this.agents.get(agentId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      throw new TerminalProtocolError('AGENT_OFFLINE', 'Requested local computer is offline.', true);
    }
    if (connection.ownerId !== userId) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Agent is not owned by the authenticated user.');
    }
    return connection;
  }

  private requireSession(userId: string, sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record || !record.session) {
      throw new TerminalProtocolError('SESSION_NOT_FOUND', 'Terminal session was not found.');
    }
    if (record.ownerId !== userId) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Terminal session is not owned by the authenticated user.');
    }
    return record;
  }

  private upsertSnapshot(snapshot: AgentSessionSnapshot, ownerId?: string): void {
    const sessionId = snapshot.session.session_id;
    const record = this.sessions.get(sessionId) ?? {
      events: [],
      eventSizes: [],
      eventHead: 0,
      latestSequence: 0,
      earliestSequence: 1,
      retainedBytes: 0,
      totalEvents: 0,
      totalOutputBytes: 0,
      commandCount: 0,
    };
    if (ownerId !== undefined) record.ownerId = ownerId;
    record.agentId = snapshot.session.agent_id;
    record.session = { ...snapshot.session };
    this.sessions.set(sessionId, record);
  }

  private withServerCursor(snapshot: AgentSessionSnapshot): AgentSessionSnapshot {
    const record = this.sessions.get(snapshot.session.session_id);
    return {
      session: { ...snapshot.session },
      cursor: record?.latestSequence ?? 0,
      earliestCursor: Math.max(0, (record?.earliestSequence ?? 1) - 1),
    };
  }

  private storeEvent(event: TerminalEvent, agentId: string, ownerId: string): void {
    const record = this.sessions.get(event.session_id) ?? {
      agentId,
      ownerId,
      events: [],
      eventSizes: [],
      eventHead: 0,
      latestSequence: 0,
      earliestSequence: 1,
      retainedBytes: 0,
      totalEvents: 0,
      totalOutputBytes: 0,
      commandCount: 0,
    };

    if (record.ownerId && record.ownerId !== ownerId) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Terminal event owner mismatch.');
    }
    if (record.agentId && record.agentId !== agentId) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Terminal event agent mismatch.');
    }
    if (event.sequence <= record.latestSequence) {
      if (event.sequence < record.earliestSequence) return;
      const duplicateIndex = record.eventHead + event.sequence - record.earliestSequence;
      const duplicate = record.events[duplicateIndex];
      if (duplicate?.sequence === event.sequence) {
        // Replays are uncommon; preserve full content-integrity validation rather than
        // trusting event_id alone as if it were a content hash.
        if (JSON.stringify(duplicate) !== JSON.stringify(event)) {
          throw new TerminalProtocolError('INVALID_ARGUMENT', 'Terminal event sequence was replayed with different content.');
        }
        return;
      }
      throw new TerminalProtocolError('INVALID_ARGUMENT', 'Terminal event stream contains an inconsistent historical sequence.');
    }
    if (event.sequence !== record.latestSequence + 1) {
      throw new TerminalProtocolError('INVALID_ARGUMENT', 'Terminal event stream contains a sequence gap.');
    }
    record.ownerId = ownerId;
    record.agentId = agentId;
    // Keep retained-byte accounting exact. Terminal output commonly contains ANSI/control
    // bytes that expand when JSON-escaped, so raw text length can materially undercount memory.
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    record.events.push(event);
    record.eventSizes.push(eventBytes);
    record.latestSequence = event.sequence;
    record.retainedBytes += eventBytes;

    // Update session metrics. Count only bytes actually emitted by terminal stdout/stderr.
    record.totalEvents += 1;
    const textPayload = (event.event_type === 'terminal.stdout' || event.event_type === 'terminal.stderr') && typeof event.data.text === 'string'
      ? event.data.text
      : undefined;
    if (textPayload !== undefined) {
      record.totalOutputBytes += Buffer.byteLength(textPayload);
    }
    if (event.event_type === 'command.input') {
      record.commandCount += 1;
    }

    if (record.session) {
      record.session.last_activity_at = event.timestamp;
      if (event.event_type === 'process.exit') {
        record.session.status = 'exited';
        record.session.exit_code = typeof event.data.exit_code === 'number' ? event.data.exit_code : null;
      } else if (event.event_type === 'session.closed') {
        record.session.status = 'closed';
        if (typeof event.data.exit_code === 'number') record.session.exit_code = event.data.exit_code;
      } else if (event.event_type === 'cwd.changed' && typeof event.data.cwd === 'string') {
        record.session.cwd = event.data.cwd;
      }
    }

    while (record.retainedBytes > this.options.maxRetainedBytesPerSession && record.events.length - record.eventHead > 1) {
      const removed = record.events[record.eventHead];
      const removedBytes = record.eventSizes[record.eventHead];
      if (!removed || removedBytes === undefined) break;
      record.eventHead += 1;
      record.retainedBytes -= removedBytes;
      record.earliestSequence = removed.sequence + 1;
    }
    if (record.eventHead >= 1024 && record.eventHead * 2 >= record.events.length) {
      record.events = record.events.slice(record.eventHead);
      record.eventSizes = record.eventSizes.slice(record.eventHead);
      record.eventHead = 0;
    }

    this.sessions.set(event.session_id, record);
    this.eventEmitter.emit(`session:${event.session_id}`, event);
  }

  private assertSnapshotIdentity(connection: AgentConnection, snapshot: AgentSessionSnapshot, userId: string, expectedSessionId?: string): void {
    if (snapshot.session.user_id !== userId || snapshot.session.agent_id !== connection.agent.agent_id) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Agent returned terminal session metadata for a different identity.');
    }
    if (expectedSessionId && snapshot.session.session_id !== expectedSessionId) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Agent returned metadata for a different terminal session.');
    }
    if (!isProfileAtMost(snapshot.session.execution_profile, connection.agent.execution_profile)) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Terminal session exceeds the connected agent execution profile.');
    }
  }

  private assertCursor(record: SessionRecord, after: number): void {
    if (after < record.earliestSequence - 1 || after > record.latestSequence) {
      throw new TerminalProtocolError('INVALID_CURSOR', 'Requested terminal cursor is outside the retained event range.');
    }
  }

  private isSessionActive(session?: TerminalSession): boolean {
    return session?.status === 'creating' || session?.status === 'running' || session?.status === 'waiting' || session?.status === 'closing' || session?.status === 'disconnected';
  }

  private isFinalSessionRetentionExpired(session: TerminalSession, now: number): boolean {
    if (this.isSessionActive(session)) return false;
    const activityMs = Date.parse(session.last_activity_at);
    return Number.isFinite(activityMs) && now - activityMs >= this.options.closedSessionRetentionMs;
  }

  private sweepRetainedSessions(): void {
    const now = Date.now();
    for (const [sessionId, record] of this.sessions) {
      if (!record.session || !this.isFinalSessionRetentionExpired(record.session, now)) continue;
      this.sessions.delete(sessionId);
      this.eventEmitter.removeAllListeners(`session:${sessionId}`);
    }
  }

  private waitForEvent(sessionId: string, after: number, waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      const key = `session:${sessionId}`;
      const listener = (event: TerminalEvent) => {
        if (event.sequence <= after) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, waitMs);
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        this.eventEmitter.off(key, listener);
      };
      this.eventEmitter.on(key, listener);
    });
  }
}

function rawDataText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isProfileAtMost(actual: ExecutionProfile, ceiling: ExecutionProfile): boolean {
  const rank: Record<ExecutionProfile, number> = { 'read-only': 0, developer: 1, 'owner-full': 2 };
  return rank[actual] <= rank[ceiling];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
