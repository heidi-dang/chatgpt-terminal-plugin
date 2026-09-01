import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Agent, TerminalEvent, TerminalSession } from '@terminal/protocol';

/** Serializable session record shared across MCP gateway instances. */
export interface SharedSessionRecord {
  ownerId?: string;
  agentId?: string;
  session?: TerminalSession;
  events: TerminalEvent[];
  latestSequence: number;
  earliestSequence: number;
  retainedBytes: number;
}

export interface AgentPresence {
  agent: Agent;
  deviceId: string;
  ownerId: string;
  online: boolean;
  lastSeenMs: number;
  /** Gateway process that currently holds the WebSocket. */
  instanceId: string;
}

export interface LiveStore {
  readonly backend: 'memory' | 'redis';
  readonly instanceId: string;

  getSession(sessionId: string): Promise<SharedSessionRecord | undefined>;
  putSession(sessionId: string, record: SharedSessionRecord): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  listSessionIdsByOwner(ownerId: string): Promise<string[]>;

  setAgentPresence(agentId: string, presence: AgentPresence): Promise<void>;
  getAgentPresence(agentId: string): Promise<AgentPresence | undefined>;
  clearAgentPresence(agentId: string, onlyIfInstance?: string): Promise<void>;
  listAgentPresenceByOwner(ownerId: string): Promise<AgentPresence[]>;

  /** Fan-out for waiters / SSE on any instance. */
  publishSessionEvent(sessionId: string, event: TerminalEvent): Promise<void>;
  subscribeSessionEvents(sessionId: string, listener: (event: TerminalEvent) => void): () => void;

  /**
   * Cross-instance agent command routing.
   * The instance that owns the agent WebSocket handles the request and replies.
   */
  requestAgentCommand(
    agentId: string,
    requestId: string,
    command: unknown,
    timeoutMs: number,
  ): Promise<unknown>;
  /** Register local handler for agents connected to this process. */
  onLocalAgentCommand(
    handler: (agentId: string, requestId: string, command: unknown) => Promise<unknown>,
  ): void;

  close(): Promise<void>;
}

const PREFIX = 'term';

function sessionKey(id: string): string {
  return `${PREFIX}:session:${id}`;
}
function ownerSessionsKey(ownerId: string): string {
  return `${PREFIX}:owner:${ownerId}:sessions`;
}
function agentKey(id: string): string {
  return `${PREFIX}:agent:${id}`;
}
function ownerAgentsKey(ownerId: string): string {
  return `${PREFIX}:owner:${ownerId}:agents`;
}
function sessionNotifyChannel(sessionId: string): string {
  return `${PREFIX}:session:${sessionId}:notify`;
}
function agentCmdChannel(agentId: string): string {
  return `${PREFIX}:agent:${agentId}:cmd`;
}
function requestResChannel(requestId: string): string {
  return `${PREFIX}:request:${requestId}:res`;
}

export class MemoryLiveStore implements LiveStore {
  readonly backend = 'memory' as const;
  readonly instanceId: string;
  private readonly sessions = new Map<string, SharedSessionRecord>();
  private readonly agents = new Map<string, AgentPresence>();
  private readonly ownerSessions = new Map<string, Set<string>>();
  private readonly ownerAgents = new Map<string, Set<string>>();
  private readonly events = new EventEmitter();
  private commandHandler?: (agentId: string, requestId: string, command: unknown) => Promise<unknown>;

  constructor(instanceId = randomUUID()) {
    this.instanceId = instanceId;
    this.events.setMaxListeners(0);
  }

  async getSession(sessionId: string): Promise<SharedSessionRecord | undefined> {
    const record = this.sessions.get(sessionId);
    return record ? cloneSession(record) : undefined;
  }

  async putSession(sessionId: string, record: SharedSessionRecord): Promise<void> {
    const previous = this.sessions.get(sessionId);
    if (previous?.ownerId) this.ownerSessions.get(previous.ownerId)?.delete(sessionId);
    this.sessions.set(sessionId, cloneSession(record));
    if (record.ownerId) {
      const set = this.ownerSessions.get(record.ownerId) ?? new Set();
      set.add(sessionId);
      this.ownerSessions.set(record.ownerId, set);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const previous = this.sessions.get(sessionId);
    if (previous?.ownerId) this.ownerSessions.get(previous.ownerId)?.delete(sessionId);
    this.sessions.delete(sessionId);
    this.events.removeAllListeners(sessionNotifyChannel(sessionId));
  }

  async listSessionIdsByOwner(ownerId: string): Promise<string[]> {
    return [...(this.ownerSessions.get(ownerId) ?? [])];
  }

  async setAgentPresence(agentId: string, presence: AgentPresence): Promise<void> {
    const previous = this.agents.get(agentId);
    if (previous && previous.ownerId !== presence.ownerId) {
      this.ownerAgents.get(previous.ownerId)?.delete(agentId);
    }
    this.agents.set(agentId, { ...presence, agent: { ...presence.agent } });
    const set = this.ownerAgents.get(presence.ownerId) ?? new Set();
    set.add(agentId);
    this.ownerAgents.set(presence.ownerId, set);
  }

  async getAgentPresence(agentId: string): Promise<AgentPresence | undefined> {
    const p = this.agents.get(agentId);
    return p ? { ...p, agent: { ...p.agent } } : undefined;
  }

  async clearAgentPresence(agentId: string, onlyIfInstance?: string): Promise<void> {
    const current = this.agents.get(agentId);
    if (!current) return;
    if (onlyIfInstance && current.instanceId !== onlyIfInstance) return;
    this.agents.delete(agentId);
    this.ownerAgents.get(current.ownerId)?.delete(agentId);
  }

  async listAgentPresenceByOwner(ownerId: string): Promise<AgentPresence[]> {
    const ids = this.ownerAgents.get(ownerId) ?? new Set();
    return [...ids]
      .map((id) => this.agents.get(id))
      .filter((p): p is AgentPresence => Boolean(p))
      .map((p) => ({ ...p, agent: { ...p.agent } }));
  }

  async publishSessionEvent(sessionId: string, event: TerminalEvent): Promise<void> {
    this.events.emit(sessionNotifyChannel(sessionId), event);
  }

  subscribeSessionEvents(sessionId: string, listener: (event: TerminalEvent) => void): () => void {
    const channel = sessionNotifyChannel(sessionId);
    this.events.on(channel, listener);
    return () => this.events.off(channel, listener);
  }

  async requestAgentCommand(
    agentId: string,
    requestId: string,
    command: unknown,
    _timeoutMs: number,
  ): Promise<unknown> {
    if (!this.commandHandler) throw new Error('No local agent command handler registered.');
    return this.commandHandler(agentId, requestId, command);
  }

  onLocalAgentCommand(
    handler: (agentId: string, requestId: string, command: unknown) => Promise<unknown>,
  ): void {
    this.commandHandler = handler;
  }

  async close(): Promise<void> {
    this.sessions.clear();
    this.agents.clear();
    this.ownerSessions.clear();
    this.ownerAgents.clear();
    this.events.removeAllListeners();
  }
}

function cloneSession(record: SharedSessionRecord): SharedSessionRecord {
  return {
    ownerId: record.ownerId,
    agentId: record.agentId,
    session: record.session ? { ...record.session } : undefined,
    events: record.events.map((e) => ({ ...e, data: { ...e.data } })),
    latestSequence: record.latestSequence,
    earliestSequence: record.earliestSequence,
    retainedBytes: record.retainedBytes,
  };
}

/** Minimal Redis client surface used by RedisLiveStore (compatible with node-redis v4). */
export interface RedisClientLike {
  connect(): Promise<void>;
  quit(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sAdd(key: string, member: string): Promise<unknown>;
  sRem(key: string, member: string): Promise<unknown>;
  sMembers(key: string): Promise<string[]>;
  publish(channel: string, message: string): Promise<unknown>;
  duplicate(): RedisClientLike;
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  isOpen?: boolean;
}

export interface RedisLiveStoreOptions {
  url: string;
  instanceId?: string;
  /** Session / presence TTL (seconds). Refreshed on activity. */
  ttlSeconds?: number;
  /** Injected client factory for tests. */
  createClient?: (url: string) => RedisClientLike;
}

export class RedisLiveStore implements LiveStore {
  readonly backend = 'redis' as const;
  readonly instanceId: string;
  private readonly ttlSeconds: number;
  private client!: RedisClientLike;
  private sub!: RedisClientLike;
  private readonly localEvents = new EventEmitter();
  private commandHandler?: (agentId: string, requestId: string, command: unknown) => Promise<unknown>;
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private started = false;

  constructor(private readonly options: RedisLiveStoreOptions) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.ttlSeconds = options.ttlSeconds ?? 24 * 60 * 60;
    this.localEvents.setMaxListeners(0);
  }

  static async connect(options: RedisLiveStoreOptions): Promise<RedisLiveStore> {
    const store = new RedisLiveStore(options);
    await store.start();
    return store;
  }

  private async start(): Promise<void> {
    if (this.started) return;
    const create = this.options.createClient ?? defaultCreateRedisClient;
    this.client = create(this.options.url);
    this.sub = this.client.duplicate();
    await this.client.connect();
    await this.sub.connect();
    // Global command + response channels use pattern via explicit per-agent subscribe on demand;
    // response channel is subscribed per requestId below.
    await this.sub.subscribe(`${PREFIX}:cmd:${this.instanceId}`, (message) => {
      void this.handleIncomingCommand(message);
    });
    this.started = true;
  }

  async getSession(sessionId: string): Promise<SharedSessionRecord | undefined> {
    const raw = await this.client.get(sessionKey(sessionId));
    if (!raw) return undefined;
    return JSON.parse(raw) as SharedSessionRecord;
  }

  async putSession(sessionId: string, record: SharedSessionRecord): Promise<void> {
    const previousRaw = await this.client.get(sessionKey(sessionId));
    if (previousRaw) {
      const previous = JSON.parse(previousRaw) as SharedSessionRecord;
      if (previous.ownerId && previous.ownerId !== record.ownerId) {
        await this.client.sRem(ownerSessionsKey(previous.ownerId), sessionId);
      }
    }
    await this.client.set(sessionKey(sessionId), JSON.stringify(record), { EX: this.ttlSeconds });
    if (record.ownerId) {
      await this.client.sAdd(ownerSessionsKey(record.ownerId), sessionId);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const previous = await this.getSession(sessionId);
    if (previous?.ownerId) await this.client.sRem(ownerSessionsKey(previous.ownerId), sessionId);
    await this.client.del(sessionKey(sessionId));
  }

  async listSessionIdsByOwner(ownerId: string): Promise<string[]> {
    return this.client.sMembers(ownerSessionsKey(ownerId));
  }

  async setAgentPresence(agentId: string, presence: AgentPresence): Promise<void> {
    const previous = await this.getAgentPresence(agentId);
    if (previous && previous.ownerId !== presence.ownerId) {
      await this.client.sRem(ownerAgentsKey(previous.ownerId), agentId);
    }
    await this.client.set(agentKey(agentId), JSON.stringify(presence), { EX: this.ttlSeconds });
    await this.client.sAdd(ownerAgentsKey(presence.ownerId), agentId);
  }

  async getAgentPresence(agentId: string): Promise<AgentPresence | undefined> {
    const raw = await this.client.get(agentKey(agentId));
    if (!raw) return undefined;
    return JSON.parse(raw) as AgentPresence;
  }

  async clearAgentPresence(agentId: string, onlyIfInstance?: string): Promise<void> {
    const current = await this.getAgentPresence(agentId);
    if (!current) return;
    if (onlyIfInstance && current.instanceId !== onlyIfInstance) return;
    await this.client.del(agentKey(agentId));
    await this.client.sRem(ownerAgentsKey(current.ownerId), agentId);
  }

  async listAgentPresenceByOwner(ownerId: string): Promise<AgentPresence[]> {
    const ids = await this.client.sMembers(ownerAgentsKey(ownerId));
    const out: AgentPresence[] = [];
    for (const id of ids) {
      const p = await this.getAgentPresence(id);
      if (p) out.push(p);
    }
    return out;
  }

  async publishSessionEvent(sessionId: string, event: TerminalEvent): Promise<void> {
    this.localEvents.emit(sessionNotifyChannel(sessionId), event);
    await this.client.publish(sessionNotifyChannel(sessionId), JSON.stringify(event));
  }

  subscribeSessionEvents(sessionId: string, listener: (event: TerminalEvent) => void): () => void {
    const channel = sessionNotifyChannel(sessionId);
    const wrapped = (message: string) => {
      try {
        listener(JSON.parse(message) as TerminalEvent);
      } catch {
        // ignore malformed
      }
    };
    this.localEvents.on(channel, listener);
    void this.sub.subscribe(channel, wrapped);
    return () => {
      this.localEvents.off(channel, listener);
      void this.sub.unsubscribe(channel);
    };
  }

  async requestAgentCommand(
    agentId: string,
    requestId: string,
    command: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const presence = await this.getAgentPresence(agentId);
    if (!presence?.online) {
      throw Object.assign(new Error('Agent is offline.'), { code: 'AGENT_OFFLINE' });
    }

    // Same instance: handle locally without Redis round-trip.
    if (presence.instanceId === this.instanceId && this.commandHandler) {
      return this.commandHandler(agentId, requestId, command);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        void this.sub.unsubscribe(requestResChannel(requestId));
        reject(Object.assign(new Error('Timed out waiting for the local terminal agent.'), { code: 'AGENT_TIMEOUT' }));
      }, timeoutMs);
      timer.unref();

      this.pending.set(requestId, { resolve, reject, timer });
      void this.sub.subscribe(requestResChannel(requestId), (message) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        void this.sub.unsubscribe(requestResChannel(requestId));
        try {
          const parsed = JSON.parse(message) as { ok: boolean; result?: unknown; error?: string };
          if (!parsed.ok) {
            pending.reject(Object.assign(new Error(parsed.error ?? 'Agent request failed.'), { code: 'INVALID_ARGUMENT' }));
            return;
          }
          pending.resolve(parsed.result);
        } catch (error) {
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }).then(() =>
        this.client.publish(
          `${PREFIX}:cmd:${presence.instanceId}`,
          JSON.stringify({ agentId, requestId, command, replyInstance: this.instanceId }),
        ),
      ).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  onLocalAgentCommand(
    handler: (agentId: string, requestId: string, command: unknown) => Promise<unknown>,
  ): void {
    this.commandHandler = handler;
  }

  private async handleIncomingCommand(message: string): Promise<void> {
    if (!this.commandHandler) return;
    try {
      const parsed = JSON.parse(message) as {
        agentId: string;
        requestId: string;
        command: unknown;
      };
      try {
        const result = await this.commandHandler(parsed.agentId, parsed.requestId, parsed.command);
        await this.client.publish(
          requestResChannel(parsed.requestId),
          JSON.stringify({ ok: true, result }),
        );
      } catch (error) {
        await this.client.publish(
          requestResChannel(parsed.requestId),
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    } catch {
      // ignore malformed command envelopes
    }
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Live store is shutting down.'));
    }
    this.pending.clear();
    this.localEvents.removeAllListeners();
    try {
      if (this.sub) await this.sub.quit();
    } catch { /* ignore */ }
    try {
      if (this.client) await this.client.quit();
    } catch { /* ignore */ }
  }
}

function defaultCreateRedisClient(url: string): RedisClientLike {
  // Dynamic import keeps the package optional at typecheck time when redis is installed as a dependency.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const redis = require('redis') as {
    createClient: (opts: { url: string }) => RedisClientLike;
  };
  return redis.createClient({ url });
}

export async function createLiveStore(options: {
  redisUrl?: string;
  instanceId?: string;
}): Promise<LiveStore> {
  if (options.redisUrl) {
    return RedisLiveStore.connect({
      url: options.redisUrl,
      instanceId: options.instanceId,
    });
  }
  return new MemoryLiveStore(options.instanceId);
}
