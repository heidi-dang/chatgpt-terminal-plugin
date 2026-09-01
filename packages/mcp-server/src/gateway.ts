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
  terminalReadOutputSchema,
  type Agent,
  type AgentCommand,
  type ExecutionProfile,
  type AgentSessionSnapshot,
  type TerminalEvent,
  type TerminalReadOutput,
  type TerminalSession,
  type TerminalStartInput,
} from '@terminal/protocol';
import type { DeviceRegistry } from './device-registry.js';
import type { LiveStore, SharedSessionRecord } from './live-store.js';
import { MemoryLiveStore } from './live-store.js';

interface AgentConnection {
  agent: Agent;
  deviceId: string;
  ownerId: string;
  socket: WebSocket;
  lastSeenMs: number;
}

interface PendingRequest {
  agentId: string;
  resolve: (snapshot: AgentSessionSnapshot) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SessionRecord {
  ownerId?: string;
  agentId?: string;
  session?: TerminalSession;
  events: TerminalEvent[];
  latestSequence: number;
  earliestSequence: number;
  retainedBytes: number;
}

export interface AgentGatewayOptions {
  requestTimeoutMs: number;
  maxRetainedBytesPerSession: number;
  closedSessionRetentionMs: number;
  sessionSweepIntervalMs: number;
  deviceRegistry: DeviceRegistry;
  authChallengeTtlMs: number;
  /** Shared live-state backend (memory default, Redis when REDIS_URL is set). */
  liveStore?: LiveStore;
  onTerminalEvent?: (ownerId: string, agentId: string, event: TerminalEvent) => void | Promise<void>;
}

export class AgentGateway {
  readonly webSocketServer = new WebSocketServer({ noServer: true });
  private readonly agents = new Map<string, AgentConnection>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly eventEmitter = new EventEmitter();
  private readonly usedAuthNonces = new Map<string, number>();
  private readonly sessionSweepTimer: NodeJS.Timeout;
  private readonly liveStore: LiveStore;

  constructor(private readonly options: AgentGatewayOptions) {
    this.liveStore = options.liveStore ?? new MemoryLiveStore();
    this.webSocketServer.on('connection', (socket, request) => this.accept(socket, request));
    this.sessionSweepTimer = setInterval(() => void this.sweepRetainedSessions(), options.sessionSweepIntervalMs);
    this.sessionSweepTimer.unref();
    this.liveStore.onLocalAgentCommand(async (agentId, requestId, command) => {
      const connection = this.agents.get(agentId);
      if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
        throw new TerminalProtocolError('AGENT_OFFLINE', 'Requested local computer is offline on this instance.', true);
      }
      return this.request(connection, command as AgentCommand);
    });
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      this.webSocketServer.emit('connection', ws, request);
    });
  }

  async listAgents(userId: string): Promise<Agent[]> {
    const presence = await this.liveStore.listAgentPresenceByOwner(userId);
    const byId = new Map<string, Agent>();
    for (const entry of presence) {
      const local = this.agents.get(entry.agent.agent_id);
      const online = local
        ? local.socket.readyState === WebSocket.OPEN
        : entry.online && entry.instanceId !== this.liveStore.instanceId
          ? entry.online
          : false;
      byId.set(entry.agent.agent_id, {
        ...entry.agent,
        online,
        last_seen: new Date(local?.lastSeenMs ?? entry.lastSeenMs).toISOString(),
      });
    }
    for (const local of this.agents.values()) {
      if (local.ownerId !== userId) continue;
      byId.set(local.agent.agent_id, {
        ...local.agent,
        online: local.socket.readyState === WebSocket.OPEN,
        last_seen: new Date(local.lastSeenMs).toISOString(),
      });
    }
    return [...byId.values()];
  }

  async listSessions(userId: string): Promise<TerminalSession[]> {
    const ids = await this.liveStore.listSessionIdsByOwner(userId);
    // Parallel session loads: N independent Redis/cache lookups instead of sequential awaits.
    const records = await Promise.all(ids.map((id) => this.loadSession(id)));
    const sessions: TerminalSession[] = [];
    for (const record of records) {
      if (record?.ownerId === userId && record.session) sessions.push({ ...record.session });
    }
    return sessions;
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
    const snapshot = await this.dispatchAgentCommand(userId, input.agent_id, {
      type: 'request',
      request_id: randomUUID(),
      action: 'terminal.start',
      user_id: userId,
      execution_profile: executionProfile,
      input,
    });
    if (snapshot.session.user_id !== userId || snapshot.session.agent_id !== input.agent_id) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Agent returned terminal session metadata for a different identity.');
    }
    if (!isProfileAtMost(snapshot.session.execution_profile, executionProfile)) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Agent returned a terminal session with a more privileged execution profile than requested.');
    }
    await this.upsertSnapshot(snapshot, userId);
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

  async read(userId: string, sessionId: string, after: number, maxBytes: number, waitMs = 0): Promise<TerminalReadOutput> {
    const record = await this.requireSession(userId, sessionId);
    this.assertCursor(record, after);

    if (after === record.latestSequence && waitMs > 0 && this.isSessionActive(record.session)) {
      await this.waitForEvent(sessionId, after, waitMs);
    }

    const refreshed = await this.requireSession(userId, sessionId);
    this.assertCursor(refreshed, after);
    const events: TerminalEvent[] = [];
    let bytes = 0;

    for (const event of refreshed.events) {
      if (event.sequence <= after) continue;
      const eventBytes = Buffer.byteLength(JSON.stringify(event));
      if (events.length > 0 && bytes + eventBytes > maxBytes) break;
      if (events.length === 0 && eventBytes > maxBytes) {
        throw new TerminalProtocolError('OUTPUT_LIMIT_REACHED', 'A terminal event exceeds the requested MCP read limit.');
      }
      events.push(event);
      bytes += eventBytes;
    }

    const nextCursor = events.at(-1)?.sequence ?? after;
    const output = events
      .filter((event) => event.event_type === 'terminal.stdout' || event.event_type === 'terminal.stderr')
      .map((event) => (typeof event.data.text === 'string' ? event.data.text : ''))
      .join('');

    return terminalReadOutputSchema.parse({
      output,
      events,
      next_cursor: nextCursor,
      has_more: nextCursor < refreshed.latestSequence,
      status: refreshed.session?.status ?? 'disconnected',
      exit_code: refreshed.session?.exit_code ?? null,
    });
  }

  async getSessionForUser(userId: string, sessionId: string): Promise<SessionRecord> {
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
    for (const connection of this.agents.values()) {
      void this.liveStore.clearAgentPresence(connection.agent.agent_id, this.liveStore.instanceId);
      connection.socket.close(1001, 'gateway shutting down');
    }
    this.agents.clear();
    this.sessions.clear();
    this.eventEmitter.removeAllListeners();
    this.webSocketServer.close();
    void this.liveStore.close();
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
          const nowMs = Date.now();
          const agent = { ...message.agent, online: true, last_seen: new Date(nowMs).toISOString() };
          this.agents.set(message.agent.agent_id, {
            agent,
            deviceId,
            ownerId,
            socket,
            lastSeenMs: nowMs,
          });
          void this.liveStore.setAgentPresence(message.agent.agent_id, {
            agent,
            deviceId,
            ownerId,
            online: true,
            lastSeenMs: nowMs,
            instanceId: this.liveStore.instanceId,
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

        if (message.type === 'ack') return;
        if (message.type === 'heartbeat') {
          // Refresh shared presence TTL so multi-instance listAgents stays accurate.
          void this.liveStore.setAgentPresence(registeredAgentId, {
            agent: { ...connection.agent, online: true, last_seen: connection.agent.last_seen },
            deviceId: connection.deviceId,
            ownerId: connection.ownerId,
            online: true,
            lastSeenMs: connection.lastSeenMs,
            instanceId: this.liveStore.instanceId,
          });
          return;
        }
        if (message.type === 'event') {
          void (async () => {
            try {
              await this.storeEvent(message.event, registeredAgentId, ownerId);
              void this.options.onTerminalEvent?.(ownerId, registeredAgentId, message.event);
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'ack', session_id: message.event.session_id, sequence: message.event.sequence }));
              }
            } catch (error) {
              console.error(JSON.stringify({ level: 'error', event: 'gateway.store_event_failed', error: errorMessage(error) }));
              if (socket.readyState === WebSocket.OPEN) socket.close(1008, 'invalid terminal event');
            }
          })();
          return;
        }
        if (message.type === 'agent.resume') {
          if (message.agent_id !== registeredAgentId) throw new TerminalProtocolError('PERMISSION_DENIED', 'Agent resume identity mismatch.');
          void (async () => {
            try {
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
                  await this.liveStore.deleteSession(session.session_id);
                  continue;
                }
                // Prefer shared store so resume is correct after failover / multi-instance.
                const existing = await this.loadSession(session.session_id);
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
                  latestSequence: baseCursor,
                  earliestSequence: baseCursor + 1,
                  retainedBytes: 0,
                };
                if (record.latestSequence < snapshot.earliestCursor) {
                  record.events = [];
                  record.retainedBytes = 0;
                  record.latestSequence = snapshot.earliestCursor;
                  record.earliestSequence = snapshot.earliestCursor + 1;
                }
                this.sessions.set(session.session_id, record);
                sequences[session.session_id] = record.latestSequence;
                const resumed = { ...session };
                if (resumed.status === 'disconnected') resumed.status = 'running';
                await this.upsertSnapshot({ ...snapshot, session: resumed }, ownerId);
              }
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'agent.resume.ack', sequences }));
              }
            } catch (error) {
              console.error(JSON.stringify({ level: 'error', event: 'gateway.resume_failed', error: errorMessage(error) }));
              if (socket.readyState === WebSocket.OPEN) socket.close(1008, 'invalid agent resume');
            }
          })();
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
        void this.liveStore.setAgentPresence(registeredAgentId, {
          agent: { ...current.agent, online: false, last_seen: new Date(current.lastSeenMs).toISOString() },
          deviceId: current.deviceId,
          ownerId: current.ownerId,
          online: false,
          lastSeenMs: current.lastSeenMs,
          instanceId: this.liveStore.instanceId,
        });
        for (const record of this.sessions.values()) {
          if (record.agentId === registeredAgentId && record.session && this.isSessionActive(record.session)) {
            record.session.status = 'disconnected';
            void this.persistSession(record.session.session_id, record);
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
    const record = await this.requireSession(userId, sessionId);
    if (!record.agentId) throw new TerminalProtocolError('AGENT_OFFLINE', 'Session is not associated with an agent.', true);
    const snapshot = await this.dispatchAgentCommand(userId, record.agentId, command);
    if (snapshot.session.user_id !== userId || snapshot.session.agent_id !== record.agentId) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Agent returned terminal session metadata for a different identity.');
    }
    if (snapshot.session.session_id !== sessionId) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Agent returned metadata for a different terminal session.');
    }
    await this.upsertSnapshot(snapshot, userId);
    return this.withServerCursor(snapshot);
  }

  private async dispatchAgentCommand(userId: string, agentId: string, command: AgentCommand): Promise<AgentSessionSnapshot> {
    const local = this.agents.get(agentId);
    if (local && local.socket.readyState === WebSocket.OPEN) {
      if (local.ownerId !== userId) {
        throw new TerminalProtocolError('PERMISSION_DENIED', 'Agent is not owned by the authenticated user.');
      }
      return this.request(local, command);
    }

    const presence = await this.liveStore.getAgentPresence(agentId);
    if (!presence || presence.ownerId !== userId) {
      throw new TerminalProtocolError('AGENT_OFFLINE', 'Requested local computer is offline.', true);
    }
    if (!presence.online) {
      throw new TerminalProtocolError('AGENT_OFFLINE', 'Requested local computer is offline.', true);
    }

    try {
      const result = await this.liveStore.requestAgentCommand(
        agentId,
        command.request_id,
        command,
        this.options.requestTimeoutMs,
      );
      return agentSessionSnapshotSchema.parse(result);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        const code = String((error as { code: string }).code);
        if (code === 'AGENT_OFFLINE' || code === 'AGENT_TIMEOUT') {
          throw new TerminalProtocolError(code as 'AGENT_OFFLINE' | 'AGENT_TIMEOUT', error instanceof Error ? error.message : String(error), true);
        }
      }
      throw error;
    }
  }

  private request(connection: AgentConnection, command: AgentCommand): Promise<AgentSessionSnapshot> {
    if (connection.socket.readyState !== WebSocket.OPEN) {
      throw new TerminalProtocolError('AGENT_OFFLINE', 'Agent is offline.', true);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.request_id);
        reject(new TerminalProtocolError('AGENT_TIMEOUT', 'Timed out waiting for the local terminal agent.', true));
      }, this.options.requestTimeoutMs);
      timer.unref();
      this.pending.set(command.request_id, { agentId: connection.agent.agent_id, resolve, reject, timer });
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

    pending.resolve(agentSessionSnapshotSchema.parse(response.result));
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

  private async requireSession(userId: string, sessionId: string): Promise<SessionRecord> {
    const record = await this.loadSession(sessionId);
    if (!record || !record.session) {
      throw new TerminalProtocolError('SESSION_NOT_FOUND', 'Terminal session was not found.');
    }
    if (record.ownerId !== userId) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Terminal session is not owned by the authenticated user.');
    }
    return record;
  }

  private async loadSession(sessionId: string): Promise<SessionRecord | undefined> {
    const cached = this.sessions.get(sessionId);
    const shared = await this.liveStore.getSession(sessionId);
    if (!shared) return cached;
    // Prefer the fresher of local cache vs shared store (multi-instance consistency).
    if (cached && cached.latestSequence >= shared.latestSequence) return cached;
    const record: SessionRecord = {
      ownerId: shared.ownerId,
      agentId: shared.agentId,
      session: shared.session ? { ...shared.session } : undefined,
      events: shared.events.map((e) => ({ ...e, data: { ...e.data } })),
      latestSequence: shared.latestSequence,
      earliestSequence: shared.earliestSequence,
      retainedBytes: shared.retainedBytes,
    };
    this.sessions.set(sessionId, record);
    return record;
  }

  private async persistSession(sessionId: string, record: SessionRecord): Promise<void> {
    const shared: SharedSessionRecord = {
      ownerId: record.ownerId,
      agentId: record.agentId,
      session: record.session ? { ...record.session } : undefined,
      events: record.events.map((e) => ({ ...e, data: { ...e.data } })),
      latestSequence: record.latestSequence,
      earliestSequence: record.earliestSequence,
      retainedBytes: record.retainedBytes,
    };
    await this.liveStore.putSession(sessionId, shared);
  }

  private async upsertSnapshot(snapshot: AgentSessionSnapshot, ownerId?: string): Promise<void> {
    const sessionId = snapshot.session.session_id;
    const record = (await this.loadSession(sessionId)) ?? {
      events: [],
      latestSequence: 0,
      earliestSequence: 1,
      retainedBytes: 0,
    };
    if (ownerId !== undefined) record.ownerId = ownerId;
    record.agentId = snapshot.session.agent_id;
    record.session = { ...snapshot.session };
    this.sessions.set(sessionId, record);
    await this.persistSession(sessionId, record);
  }

  private withServerCursor(snapshot: AgentSessionSnapshot): AgentSessionSnapshot {
    const record = this.sessions.get(snapshot.session.session_id);
    return {
      session: { ...snapshot.session },
      cursor: record?.latestSequence ?? 0,
      earliestCursor: Math.max(0, (record?.earliestSequence ?? 1) - 1),
    };
  }

  private async storeEvent(event: TerminalEvent, agentId: string, ownerId: string): Promise<void> {
    // Seed from shared store so multi-instance sequence checks stay coherent.
    const loaded = await this.loadSession(event.session_id);
    const record = loaded ?? {
      agentId,
      ownerId,
      events: [],
      latestSequence: 0,
      earliestSequence: 1,
      retainedBytes: 0,
    };

    if (record.ownerId && record.ownerId !== ownerId) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Terminal event owner mismatch.');
    }
    if (record.agentId && record.agentId !== agentId) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Terminal event agent mismatch.');
    }
    if (event.sequence <= record.latestSequence) {
      // Replays almost always target the latest retained event — check the tail first (O(1)).
      const tail = record.events[record.events.length - 1];
      const duplicate =
        tail?.sequence === event.sequence
          ? tail
          : record.events.find((item) => item.sequence === event.sequence);
      if (duplicate) {
        // Fast path: identical event_id means safe replay without full JSON compare.
        if (duplicate.event_id === event.event_id) return;
        if (JSON.stringify(duplicate) !== JSON.stringify(event)) {
          throw new TerminalProtocolError('INVALID_ARGUMENT', 'Terminal event sequence was replayed with different content.');
        }
        return;
      }
      if (event.sequence < record.earliestSequence) return;
      throw new TerminalProtocolError('INVALID_ARGUMENT', 'Terminal event stream contains an inconsistent historical sequence.');
    }
    if (event.sequence !== record.latestSequence + 1) {
      throw new TerminalProtocolError('INVALID_ARGUMENT', 'Terminal event stream contains a sequence gap.');
    }
    record.ownerId = ownerId;
    record.agentId = agentId;
    record.events.push(event);
    record.latestSequence = event.sequence;
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    record.retainedBytes += eventBytes;

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

    while (record.retainedBytes > this.options.maxRetainedBytesPerSession && record.events.length > 1) {
      const removed = record.events.shift();
      if (!removed) break;
      record.retainedBytes -= Buffer.byteLength(JSON.stringify(removed));
      record.earliestSequence = removed.sequence + 1;
    }

    this.sessions.set(event.session_id, record);
    await this.persistSession(event.session_id, record);
    this.eventEmitter.emit(`session:${event.session_id}`, event);
    await this.liveStore.publishSessionEvent(event.session_id, event);
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

  private async sweepRetainedSessions(): Promise<void> {
    const now = Date.now();
    for (const [sessionId, record] of this.sessions) {
      if (!record.session || !this.isFinalSessionRetentionExpired(record.session, now)) continue;
      this.sessions.delete(sessionId);
      this.eventEmitter.removeAllListeners(`session:${sessionId}`);
      await this.liveStore.deleteSession(sessionId);
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
      const unsubStore = this.liveStore.subscribeSessionEvents(sessionId, listener);
      const cleanup = () => {
        clearTimeout(timer);
        this.eventEmitter.off(key, listener);
        unsubStore();
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
