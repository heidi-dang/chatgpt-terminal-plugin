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

/** O(1)-ish field peek without parsing large event arrays (big-key delete path). */
function extractJsonStringField(raw: string, field: string): string | undefined {
  const re = new RegExp(`"${field}"\s*:\s*"((?:\\.|[^"\\])*)"`);
  const m = re.exec(raw);
  if (!m?.[1]) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
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
  mGet?(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, options?: { EX?: number; XX?: boolean; NX?: boolean }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sAdd(key: string, member: string): Promise<unknown>;
  /** Supports multi-member SREM (Redis) to prune stale index entries in one RTT. */
  sRem(key: string, ...members: string[]): Promise<unknown>;
  sMembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
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
    // After reconnect, node-redis restores subscriptions for channels registered via subscribe();
    // re-assert the command channel explicitly so HA command routing recovers.
    this.sub.on?.('ready', () => {
      if (this.closed) return;
      void this.resubscribeCommandChannel();
    });
    await this.client.connect();
    await this.sub.connect();
    await this.resubscribeCommandChannel();
    this.started = true;
  }

  private async resubscribeCommandChannel(): Promise<void> {
    try {
      await this.sub.subscribe(cmdChannel(this.instanceId), (message) => {
        void this.handleIncomingCommand(message);
      });
      // Restore active session/request channels after reconnect.
      for (const [channel, handler] of this.channelHandlers) {
        try {
          await this.sub.subscribe(channel, handler);
        } catch (error) {
          console.error(JSON.stringify({
            level: 'error',
            event: 'redis.resubscribe_failed',
            channel,
            error: String(error),
          }));
        }
      }
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'redis.cmd_resubscribe_failed',
        error: String(error),
      }));
    }
  }

  async getSession(sessionId: string): Promise<SharedSessionRecord | undefined> {
    const raw = await this.client.get(sessionKey(sessionId));
    if (!raw) return undefined;
    const parsed = safeParseJson<SharedSessionRecord>(raw);
    return parsed ? cloneSession(parsed) : undefined;
  }

  async putSession(sessionId: string, record: SharedSessionRecord): Promise<void> {
    const key = sessionKey(sessionId);
    const ttl = String(this.ttlSeconds);

    // With Lua CAS, skip a pre-GET RTT: Redis re-reads current and rejects stale sequences.
    // Callers (gateway) already hold the authoritative buffer; merge is only needed without Lua.
    // Owner index SADD+EXPIRE runs inside the same EVAL (1 RTT vs EVAL+SADD+EXPIRE).
    if (this.client.eval) {
      const payload = JSON.stringify(record);
      const ownerKey = record.ownerId ? ownerSessionsKey(record.ownerId) : '';
      await this.client.eval(PUT_SESSION_LUA, {
        keys: [key, ownerKey || key],
        arguments: [payload, ttl, sessionId, record.ownerId ? '1' : '0'],
      });
      return;
    }

    const previous = await this.getSession(sessionId);
    const merged = mergeSessionRecords(previous, record);
    if (previous && merged.latestSequence < previous.latestSequence) return;
    await this.client.set(key, JSON.stringify(merged), { EX: this.ttlSeconds });
    await this.reindexSessionOwner(sessionId, previous?.ownerId, merged.ownerId);
  }

  private async reindexSessionOwner(
    sessionId: string,
    previousOwnerId: string | undefined,
    nextOwnerId: string | undefined,
  ): Promise<void> {
    if (previousOwnerId && previousOwnerId !== nextOwnerId) {
      await this.client.sRem(ownerSessionsKey(previousOwnerId), sessionId);
    }
    if (nextOwnerId) {
      await this.client.sAdd(ownerSessionsKey(nextOwnerId), sessionId);
      await this.client.expire(ownerSessionsKey(nextOwnerId), this.ttlSeconds);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const key = sessionKey(sessionId);
    // One EVAL: peek ownerId + SREM + DEL (was GET + optional SREM + DEL = up to 3 RTTs).
    // Still avoids full JSON.parse of large event buffers (ownerId matched in Lua).
    if (this.client.eval) {
      await this.client.eval(DELETE_SESSION_LUA, {
        keys: [key],
        arguments: [sessionId, `${PREFIX}:owner:`],
      });
      return;
    }
    const raw = await this.client.get(key);
    if (raw) {
      const ownerId = extractJsonStringField(raw, 'ownerId');
      if (ownerId) await this.client.sRem(ownerSessionsKey(ownerId), sessionId);
    }
    await this.client.del(key);
  }

  async listSessionIdsByOwner(ownerId: string): Promise<string[]> {
    const ids = await this.client.sMembers(ownerSessionsKey(ownerId));
    if (ids.length === 0) return [];
    // One MGET instead of N sequential GETs when pruning expired session index members.
    const values = await this.mGetKeys(ids.map((id) => sessionKey(id)));
    const live: string[] = [];
    const stale: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (values[i]) live.push(ids[i]!);
      else stale.push(ids[i]!);
    }
    if (stale.length > 0) {
      // Single multi-member SREM instead of N round-trips.
      await this.client.sRem(ownerSessionsKey(ownerId), ...stale);
    }
    return live;
  }

  async setAgentPresence(agentId: string, presence: AgentPresence): Promise<void> {
    const key = agentKey(agentId);
    const payload = JSON.stringify(presence);
    const ttl = String(this.ttlSeconds);

    // Lua CAS + owner index in one EVAL (avoids pre-GET and post SADD/EXPIRE RTTs).
    if (this.client.eval) {
      await this.client.eval(SET_PRESENCE_LUA, {
        keys: [key, ownerAgentsKey(presence.ownerId)],
        arguments: [payload, ttl, String(presence.lastSeenMs), agentId],
      });
      return;
    }

    const previous = await this.getAgentPresence(agentId);
    if (previous && previous.lastSeenMs > presence.lastSeenMs) return;
    await this.client.set(key, payload, { EX: this.ttlSeconds });
    if (previous && previous.ownerId !== presence.ownerId) {
      await this.client.sRem(ownerAgentsKey(previous.ownerId), agentId);
    }
    await this.client.sAdd(ownerAgentsKey(presence.ownerId), agentId);
    await this.client.expire(ownerAgentsKey(presence.ownerId), this.ttlSeconds);
  }

  async getAgentPresence(agentId: string): Promise<AgentPresence | undefined> {
    const raw = await this.client.get(agentKey(agentId));
    if (!raw) return undefined;
    return safeParseJson<AgentPresence>(raw);
  }

  async clearAgentPresence(agentId: string, onlyIfInstance?: string): Promise<void> {
    const key = agentKey(agentId);
    const current = await this.getAgentPresence(agentId);
    if (!current) return;
    if (onlyIfInstance && current.instanceId !== onlyIfInstance) return;

    if (this.client.eval) {
      await this.client.eval(CLEAR_PRESENCE_LUA, {
        keys: [key, ownerAgentsKey(current.ownerId)],
        arguments: [agentId, onlyIfInstance ?? ''],
      });
      return;
    }

    const again = await this.getAgentPresence(agentId);
    if (!again) return;
    if (onlyIfInstance && again.instanceId !== onlyIfInstance) return;
    if (again.lastSeenMs !== current.lastSeenMs) return;
    await this.client.del(key);
    await this.client.sRem(ownerAgentsKey(current.ownerId), agentId);
  }

  async listAgentPresenceByOwner(ownerId: string): Promise<AgentPresence[]> {
    const ids = await this.client.sMembers(ownerAgentsKey(ownerId));
    if (ids.length === 0) return [];
    // Batch presence reads: 1 RTT instead of N for listAgents / multi-instance views.
    const values = await this.mGetKeys(ids.map((id) => agentKey(id)));
    const out: AgentPresence[] = [];
    const stale: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const raw = values[i];
      if (!raw) {
        stale.push(ids[i]!);
        continue;
      }
      const p = safeParseJson<AgentPresence>(raw);
      if (p) out.push(p);
      else stale.push(ids[i]!);
    }
    if (stale.length > 0) {
      await this.client.sRem(ownerAgentsKey(ownerId), ...stale);
    }
    return out;
  }

  private async mGetKeys(keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    if (this.client.mGet) return this.client.mGet(keys);
    // Fallback for minimal test doubles without MGET.
    return Promise.all(keys.map((key) => this.client.get(key)));
  }

  async publishSessionEvent(sessionId: string, event: TerminalEvent): Promise<void> {
    // Single delivery path: Redis pub/sub fans out to every instance (including this one)
    // via subscribeSessionEvents → localEvents. Emitting locally here would double-deliver.
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

/** Lua: delete session + owner index SREM without shipping the blob to the app. */
const DELETE_SESSION_LUA = `
local key = KEYS[1]
local sessionId = ARGV[1]
local ownerPrefix = ARGV[2]
local current = redis.call('GET', key)
if current then
  local ownerId = string.match(current, '"ownerId":"([^"]*)"')
  if ownerId and ownerId ~= '' and ownerPrefix ~= '' then
    redis.call('SREM', ownerPrefix .. ownerId .. ':sessions', sessionId)
  end
end
redis.call('DEL', key)
return 1
`;

/** Lua: CAS on latestSequence + optional owner-session index update in one RTT. */
const PUT_SESSION_LUA = `
local key = KEYS[1]
local ownerKey = KEYS[2]
local incoming = ARGV[1]
local ttl = tonumber(ARGV[2])
local sessionId = ARGV[3]
local indexOwner = ARGV[4]
local current = redis.call('GET', key)
if current then
  local curSeq = tonumber(string.match(current, '"latestSequence":(%d+)')) or 0
  local incSeq = tonumber(string.match(incoming, '"latestSequence":(%d+)')) or 0
  if incSeq < curSeq then
    return current
  end
end
redis.call('SET', key, incoming, 'EX', ttl)
if indexOwner == '1' and ownerKey ~= '' and sessionId ~= '' then
  redis.call('SADD', ownerKey, sessionId)
  redis.call('EXPIRE', ownerKey, ttl)
end
return incoming
`;

/** Lua: delete presence only if instance matches (when provided). */
const CLEAR_PRESENCE_LUA = `
local key = KEYS[1]
local ownerKey = KEYS[2]
local agentId = ARGV[1]
local onlyInstance = ARGV[2]
local current = redis.call('GET', key)
if not current then return 0 end
if onlyInstance ~= '' then
  local inst = string.match(current, '"instanceId":"([^"]+)"') or ''
  if inst ~= onlyInstance then return 0 end
end
redis.call('DEL', key)
redis.call('SREM', ownerKey, agentId)
return 1
`;

/** Lua: presence CAS + owner agent index in one RTT. */
const SET_PRESENCE_LUA = `
local key = KEYS[1]
local ownerKey = KEYS[2]
local incoming = ARGV[1]
local ttl = tonumber(ARGV[2])
local lastSeen = tonumber(ARGV[3]) or 0
local agentId = ARGV[4]
local current = redis.call('GET', key)
if current then
  local curSeen = tonumber(string.match(current, '"lastSeenMs":(%d+)')) or 0
  if lastSeen < curSeen then
    return 0
  end
end
redis.call('SET', key, incoming, 'EX', ttl)
if ownerKey ~= '' and agentId ~= '' then
  redis.call('SADD', ownerKey, agentId)
  redis.call('EXPIRE', ownerKey, ttl)
end
return 1
`;

function defaultCreateRedisClient(url: string): RedisClientLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const redis = require('redis') as {
    createClient: (opts: {
      url: string;
      socket?: {
        reconnectStrategy?: (retries: number) => number | Error;
        connectTimeout?: number;
      };
    }) => RedisClientLike;
  };
  // Ops note: configure Redis maxmemory + volatile-ttl (or allkeys-lru) server-side so
  // session/presence keys with EX expire under pressure instead of OOM. App sets EX on all live keys.
  return redis.createClient({
    url,
    socket: {
      connectTimeout: 10_000,
      // Exponential backoff capped at 5s; never give up while process lives.
      reconnectStrategy: (retries) => Math.min(100 * 2 ** Math.min(retries, 6), 5_000),
    },
  });
}

export async function createLiveStore(options: {
  redisUrl?: string;
  instanceId?: string;
}): Promise<LiveStore> {
  if (options.redisUrl) {
    try {
      const store = await RedisLiveStore.connect({
        url: options.redisUrl,
        instanceId: options.instanceId,
      });
      console.info(JSON.stringify({
        level: 'info',
        event: 'live_store.ready',
        backend: 'redis',
        instance_id: store.instanceId,
      }));
      return store;
    } catch (error) {
      // Fail closed when REDIS_URL is configured: silent memory fallback would split-brain agents.
      throw new Error(
        `Failed to connect Redis live store at ${options.redisUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const memory = new MemoryLiveStore(options.instanceId);
  console.info(JSON.stringify({
    level: 'info',
    event: 'live_store.ready',
    backend: 'memory',
    instance_id: memory.instanceId,
  }));
  return memory;
}
