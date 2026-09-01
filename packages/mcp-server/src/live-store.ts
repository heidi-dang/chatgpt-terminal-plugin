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

  publishSessionEvent(sessionId: string, event: TerminalEvent): Promise<void>;
  subscribeSessionEvents(sessionId: string, listener: (event: TerminalEvent) => void): () => void;

  requestAgentCommand(
    agentId: string,
    requestId: string,
    command: unknown,
    timeoutMs: number,
  ): Promise<unknown>;
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
function requestResChannel(requestId: string): string {
  return `${PREFIX}:request:${requestId}:res`;
}
function cmdChannel(instanceId: string): string {
  return `${PREFIX}:cmd:${instanceId}`;
}

function safeParseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
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

/** Keep the higher-sequence session when merging concurrent writers. */
export function mergeSessionRecords(
  current: SharedSessionRecord | undefined,
  incoming: SharedSessionRecord,
): SharedSessionRecord {
  if (!current) return cloneSession(incoming);
  if (incoming.latestSequence < current.latestSequence) return cloneSession(current);
  if (incoming.latestSequence > current.latestSequence) return cloneSession(incoming);
  // Same sequence: prefer the record with more retained event detail / newer session status.
  const currentActivity = current.session?.last_activity_at ?? '';
  const incomingActivity = incoming.session?.last_activity_at ?? '';
  if (incomingActivity > currentActivity) return cloneSession(incoming);
  return cloneSession(current);
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
    const merged = mergeSessionRecords(previous, record);
    if (previous?.ownerId && previous.ownerId !== merged.ownerId) {
      this.ownerSessions.get(previous.ownerId)?.delete(sessionId);
    }
    this.sessions.set(sessionId, merged);
    if (merged.ownerId) {
      const set = this.ownerSessions.get(merged.ownerId) ?? new Set();
      set.add(sessionId);
      this.ownerSessions.set(merged.ownerId, set);
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
    // Prefer the fresher lastSeen; ignore stale offline overwrites of a newer online presence.
    if (previous && previous.lastSeenMs > presence.lastSeenMs) return;
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

/** Minimal Redis client surface used by RedisLiveStore (compatible with node-redis v4). */
export interface RedisClientLike {
  connect(): Promise<void>;
  quit(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number; XX?: boolean; NX?: boolean }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sAdd(key: string, member: string): Promise<unknown>;
  sRem(key: string, member: string): Promise<unknown>;
  sMembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  duplicate(): RedisClientLike;
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  isOpen?: boolean;
}

export interface RedisLiveStoreOptions {
  url: string;
  instanceId?: string;
  /** Session / presence TTL (seconds). Refreshed on activity. */
  ttlSeconds?: number;
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
  /** Refcount Redis channel subscriptions so concurrent waiters share one SUBSCRIBE. */
  private readonly channelRefCount = new Map<string, number>();
  private readonly channelHandlers = new Map<string, (message: string, channel: string) => void>();
  private started = false;
  private closed = false;

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
    this.client.on?.('error', (err) => {
      console.error(JSON.stringify({ level: 'error', event: 'redis.client_error', error: String(err) }));
    });
    this.sub.on?.('error', (err) => {
      console.error(JSON.stringify({ level: 'error', event: 'redis.sub_error', error: String(err) }));
    });
    await this.client.connect();
    await this.sub.connect();
    await this.sub.subscribe(cmdChannel(this.instanceId), (message) => {
      void this.handleIncomingCommand(message);
    });
    this.started = true;
  }

  async getSession(sessionId: string): Promise<SharedSessionRecord | undefined> {
    const raw = await this.client.get(sessionKey(sessionId));
    if (!raw) return undefined;
    return safeParseJson<SharedSessionRecord>(raw);
  }

  async putSession(sessionId: string, record: SharedSessionRecord): Promise<void> {
    const key = sessionKey(sessionId);
    const previousRaw = await this.client.get(key);
    const previous = previousRaw ? safeParseJson<SharedSessionRecord>(previousRaw) : undefined;
    const merged = mergeSessionRecords(previous, record);

    if (previous?.ownerId && previous.ownerId !== merged.ownerId) {
      await this.client.sRem(ownerSessionsKey(previous.ownerId), sessionId);
    }

    // Monotonic write: refuse to clobber a concurrent higher sequence that appeared after read.
    if (previous && merged.latestSequence < previous.latestSequence) {
      return;
    }

    await this.client.set(key, JSON.stringify(merged), { EX: this.ttlSeconds });
    if (merged.ownerId) {
      await this.client.sAdd(ownerSessionsKey(merged.ownerId), sessionId);
      await this.client.expire(ownerSessionsKey(merged.ownerId), this.ttlSeconds);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const previous = await this.getSession(sessionId);
    if (previous?.ownerId) await this.client.sRem(ownerSessionsKey(previous.ownerId), sessionId);
    await this.client.del(sessionKey(sessionId));
  }

  async listSessionIdsByOwner(ownerId: string): Promise<string[]> {
    const ids = await this.client.sMembers(ownerSessionsKey(ownerId));
    // Prune stale set members whose session keys expired.
    const live: string[] = [];
    for (const id of ids) {
      const raw = await this.client.get(sessionKey(id));
      if (raw) live.push(id);
      else await this.client.sRem(ownerSessionsKey(ownerId), id);
    }
    return live;
  }

  async setAgentPresence(agentId: string, presence: AgentPresence): Promise<void> {
    const previous = await this.getAgentPresence(agentId);
    if (previous && previous.lastSeenMs > presence.lastSeenMs) return;
    if (previous && previous.ownerId !== presence.ownerId) {
      await this.client.sRem(ownerAgentsKey(previous.ownerId), agentId);
    }
    await this.client.set(agentKey(agentId), JSON.stringify(presence), { EX: this.ttlSeconds });
    await this.client.sAdd(ownerAgentsKey(presence.ownerId), agentId);
    await this.client.expire(ownerAgentsKey(presence.ownerId), this.ttlSeconds);
  }

  async getAgentPresence(agentId: string): Promise<AgentPresence | undefined> {
    const raw = await this.client.get(agentKey(agentId));
    if (!raw) return undefined;
    return safeParseJson<AgentPresence>(raw);
  }

  async clearAgentPresence(agentId: string, onlyIfInstance?: string): Promise<void> {
    const current = await this.getAgentPresence(agentId);
    if (!current) return;
    if (onlyIfInstance && current.instanceId !== onlyIfInstance) return;
    // Re-check after read to reduce TOCTOU races (best-effort without Lua).
    const again = await this.getAgentPresence(agentId);
    if (!again) return;
    if (onlyIfInstance && again.instanceId !== onlyIfInstance) return;
    if (again.lastSeenMs !== current.lastSeenMs) return;
    await this.client.del(agentKey(agentId));
    await this.client.sRem(ownerAgentsKey(current.ownerId), agentId);
  }

  async listAgentPresenceByOwner(ownerId: string): Promise<AgentPresence[]> {
    const ids = await this.client.sMembers(ownerAgentsKey(ownerId));
    const out: AgentPresence[] = [];
    for (const id of ids) {
      const p = await this.getAgentPresence(id);
      if (p) out.push(p);
      else await this.client.sRem(ownerAgentsKey(ownerId), id);
    }
    return out;
  }

  async publishSessionEvent(sessionId: string, event: TerminalEvent): Promise<void> {
    this.localEvents.emit(sessionNotifyChannel(sessionId), event);
    if (this.closed) return;
    await this.client.publish(sessionNotifyChannel(sessionId), JSON.stringify(event));
  }

  subscribeSessionEvents(sessionId: string, listener: (event: TerminalEvent) => void): () => void {
    const channel = sessionNotifyChannel(sessionId);
    this.localEvents.on(channel, listener);

    const ref = (this.channelRefCount.get(channel) ?? 0) + 1;
    this.channelRefCount.set(channel, ref);
    if (ref === 1) {
      const handler = (message: string) => {
        const event = safeParseJson<TerminalEvent>(message);
        if (event) this.localEvents.emit(channel, event);
      };
      this.channelHandlers.set(channel, handler);
      void this.sub.subscribe(channel, handler);
    }

    return () => {
      this.localEvents.off(channel, listener);
      const next = (this.channelRefCount.get(channel) ?? 1) - 1;
      if (next <= 0) {
        this.channelRefCount.delete(channel);
        const handler = this.channelHandlers.get(channel);
        this.channelHandlers.delete(channel);
        if (handler) void this.sub.unsubscribe(channel);
      } else {
        this.channelRefCount.set(channel, next);
      }
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

    if (presence.instanceId === this.instanceId && this.commandHandler) {
      return this.commandHandler(agentId, requestId, command);
    }

    return new Promise((resolve, reject) => {
      const resChannel = requestResChannel(requestId);
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        void this.releaseChannel(resChannel);
        reject(Object.assign(new Error('Timed out waiting for the local terminal agent.'), { code: 'AGENT_TIMEOUT' }));
      }, timeoutMs);
      timer.unref();

      this.pending.set(requestId, { resolve, reject, timer });

      const onMessage = (message: string) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        void this.releaseChannel(resChannel);
        const parsed = safeParseJson<{ ok: boolean; result?: unknown; error?: string }>(message);
        if (!parsed) {
          pending.reject(new Error('Malformed agent command response.'));
          return;
        }
        if (!parsed.ok) {
          pending.reject(Object.assign(new Error(parsed.error ?? 'Agent request failed.'), { code: 'INVALID_ARGUMENT' }));
          return;
        }
        pending.resolve(parsed.result);
      };

      void this.acquireChannel(resChannel, onMessage)
        .then(() => this.client.publish(
          cmdChannel(presence.instanceId),
          JSON.stringify({ agentId, requestId, command }),
        ))
        .catch((error) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          void this.releaseChannel(resChannel);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  onLocalAgentCommand(
    handler: (agentId: string, requestId: string, command: unknown) => Promise<unknown>,
  ): void {
    this.commandHandler = handler;
  }

  private async acquireChannel(channel: string, handler: (message: string) => void): Promise<void> {
    const ref = (this.channelRefCount.get(channel) ?? 0) + 1;
    this.channelRefCount.set(channel, ref);
    this.channelHandlers.set(channel, (message) => handler(message));
    if (ref === 1) {
      await this.sub.subscribe(channel, this.channelHandlers.get(channel)!);
    }
  }

  private async releaseChannel(channel: string): Promise<void> {
    const next = (this.channelRefCount.get(channel) ?? 1) - 1;
    if (next <= 0) {
      this.channelRefCount.delete(channel);
      this.channelHandlers.delete(channel);
      try {
        await this.sub.unsubscribe(channel);
      } catch {
        // ignore
      }
    } else {
      this.channelRefCount.set(channel, next);
    }
  }

  private async handleIncomingCommand(message: string): Promise<void> {
    if (!this.commandHandler || this.closed) return;
    const parsed = safeParseJson<{ agentId: string; requestId: string; command: unknown }>(message);
    if (!parsed?.requestId || !parsed.agentId) return;
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
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Live store is shutting down.'));
    }
    this.pending.clear();
    this.localEvents.removeAllListeners();
    this.channelRefCount.clear();
    this.channelHandlers.clear();
    try {
      if (this.sub) await this.sub.quit();
    } catch { /* ignore */ }
    try {
      if (this.client) await this.client.quit();
    } catch { /* ignore */ }
  }
}

function defaultCreateRedisClient(url: string): RedisClientLike {
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
