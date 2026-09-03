import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RequestIdentity } from './service.js';

const DEFAULT_SURFACE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface TerminalTurnState {
  surface_id: string | null;
  surface_open: boolean;
  surface_active: boolean;
  session_id: string | null;
}

interface TerminalTurnRecord {
  identity: RequestIdentity;
  surfaceId: string;
  sessionId: string | null;
  surfaceExpiresAt: number;
  activeExpiresAt: number | null;
  expiryTimer: NodeJS.Timeout | undefined;
}

interface PersistedTurnRecordV1 {
  identity: RequestIdentity;
  surfaceId: string;
  sessionId: string | null;
  expiresAt: number;
}

interface PersistedTurnStateV1 {
  version: 1;
  records: PersistedTurnRecordV1[];
}

interface PersistedTurnRecordV2 {
  identity: RequestIdentity;
  surfaceId: string;
  sessionId: string | null;
  surfaceExpiresAt: number;
  activeExpiresAt: number | null;
}

interface PersistedTurnStateV2 {
  version: 2;
  records: PersistedTurnRecordV2[];
}

type PersistedTurnState = PersistedTurnStateV1 | PersistedTurnStateV2;
type CloseTerminal = (identity: RequestIdentity, sessionId: string) => Promise<void>;

export class TerminalTurnRegistry {
  private readonly records = new Map<string, TerminalTurnRecord>();
  private readonly surfaceKeys = new Map<string, string>();
  private readonly activationTails = new Map<string, Promise<void>>();
  private persistenceTail = Promise.resolve();

  constructor(
    private readonly closeTerminal: CloseTerminal,
    private readonly activeLeaseMs: number,
    private readonly statePath?: string,
    private readonly surfaceRetentionMs = DEFAULT_SURFACE_RETENTION_MS,
  ) {}

  static async load(
    closeTerminal: CloseTerminal,
    activeLeaseMs: number,
    statePath?: string,
    surfaceRetentionMs = DEFAULT_SURFACE_RETENTION_MS,
  ): Promise<TerminalTurnRegistry> {
    const registry = new TerminalTurnRegistry(closeTerminal, activeLeaseMs, statePath, surfaceRetentionMs);
    await registry.restore();
    return registry;
  }

  async begin(identity: RequestIdentity): Promise<TerminalTurnState> {
    const key = turnKey(identity);
    const existing = this.records.get(key);
    if (existing) {
      existing.identity = { ...existing.identity, ...identity };
      this.renewSurface(existing);
      if (existing.sessionId) this.renewActive(existing);
      this.scheduleExpiry(key, existing);
      await this.persist();
      return stateFromRecord(existing);
    }

    const record: TerminalTurnRecord = {
      identity: { ...identity },
      surfaceId: randomUUID(),
      sessionId: null,
      surfaceExpiresAt: Date.now() + this.surfaceRetentionMs,
      activeExpiresAt: null,
      expiryTimer: undefined,
    };
    this.records.set(key, record);
    this.surfaceKeys.set(record.surfaceId, key);
    this.scheduleExpiry(key, record);
    await this.persist();
    return stateFromRecord(record);
  }

  async recover(identity: RequestIdentity, surfaceId?: string): Promise<TerminalTurnState> {
    const currentKey = turnKey(identity);
    const current = this.records.get(currentKey);
    if (current) {
      if (surfaceId && current.surfaceId !== surfaceId) return closedState(surfaceId);
      this.renewSurface(current);
      if (current.sessionId) this.renewActive(current);
      this.scheduleExpiry(currentKey, current);
      await this.persist();
      return stateFromRecord(current);
    }

    let candidate: TerminalTurnRecord | undefined;
    let oldKey: string | undefined;
    if (surfaceId) {
      oldKey = this.surfaceKeys.get(surfaceId);
      candidate = oldKey ? this.records.get(oldKey) : undefined;
    } else if (!identity.mcpSessionId) {
      const matches = [...this.records.entries()].filter(([, record]) => samePrincipal(record.identity, identity));
      if (matches.length === 1) [oldKey, candidate] = matches[0]!;
    }
    if (!candidate || !oldKey || !samePrincipal(candidate.identity, identity)) return closedState(surfaceId ?? null);

    await this.expireDue(oldKey, candidate);
    if (this.records.get(oldKey) !== candidate) return closedState(surfaceId ?? candidate.surfaceId);

    const newKey = turnKey(identity);
    const conflict = this.records.get(newKey);
    if (conflict && conflict !== candidate) return closedState(surfaceId ?? candidate.surfaceId);
    if (oldKey !== newKey) this.records.delete(oldKey);
    candidate.identity = { ...candidate.identity, ...identity };
    this.records.set(newKey, candidate);
    this.surfaceKeys.set(candidate.surfaceId, newKey);
    this.renewSurface(candidate);
    if (candidate.sessionId) this.renewActive(candidate);
    this.scheduleExpiry(newKey, candidate);
    await this.persist();
    return stateFromRecord(candidate);
  }

  async activate(identity: RequestIdentity, sessionId: string): Promise<TerminalTurnState> {
    const key = turnKey(identity);
    const expectedRecord = this.records.get(key);
    if (!expectedRecord) {
      await this.safeClose(identity, sessionId);
      throw new Error('Terminal surface is not open for this ChatGPT turn.');
    }
    return this.withActivationLock(key, async () => {
      const record = this.records.get(key);
      if (record !== expectedRecord) {
        await this.safeClose(identity, sessionId);
        throw new Error('Terminal surface changed before PTY activation.');
      }

      if (record.sessionId && record.sessionId !== sessionId) {
        await this.safeClose(record.identity, record.sessionId);
        if (this.records.get(key) !== record) {
          await this.safeClose(identity, sessionId);
          throw new Error('Terminal surface closed while replacing its active PTY.');
        }
      }
      record.sessionId = sessionId;
      this.renewSurface(record);
      this.renewActive(record);
      this.scheduleExpiry(key, record);
      await this.persist();
      return stateFromRecord(record);
    });
  }

  touch(identity: RequestIdentity, sessionId: string): TerminalTurnState {
    const key = turnKey(identity);
    const record = this.records.get(key);
    if (!record || record.sessionId !== sessionId) return record ? stateFromRecord(record) : closedState(null);
    this.renewSurface(record);
    this.renewActive(record);
    this.scheduleExpiry(key, record);
    void this.persist().catch((error) => logPersistenceFailure(error));
    return stateFromRecord(record);
  }

  async clearActive(identity: RequestIdentity): Promise<TerminalTurnState> {
    const key = turnKey(identity);
    const record = this.records.get(key);
    if (!record) return closedState(null);
    const sessionId = record.sessionId;
    record.sessionId = null;
    record.activeExpiresAt = null;
    if (sessionId) await this.safeClose(record.identity, sessionId);
    this.renewSurface(record);
    this.scheduleExpiry(key, record);
    await this.persist();
    return stateFromRecord(record);
  }

  deactivate(identity: RequestIdentity, sessionId: string): TerminalTurnState {
    const key = turnKey(identity);
    const record = this.records.get(key);
    if (!record || record.sessionId !== sessionId) return record ? stateFromRecord(record) : closedState(null);
    record.sessionId = null;
    record.activeExpiresAt = null;
    this.renewSurface(record);
    this.scheduleExpiry(key, record);
    void this.persist().catch((error) => logPersistenceFailure(error));
    return stateFromRecord(record);
  }

  current(identity: RequestIdentity): TerminalTurnState {
    const record = this.records.get(turnKey(identity));
    return record ? stateFromRecord(record) : closedState(null);
  }

  status(identity: RequestIdentity, surfaceId: string): TerminalTurnState {
    const key = turnKey(identity);
    const record = this.records.get(key);
    if (!record || record.surfaceId !== surfaceId) return closedState(surfaceId);
    this.renewSurface(record);
    if (record.sessionId) this.renewActive(record);
    this.scheduleExpiry(key, record);
    void this.persist().catch((error) => logPersistenceFailure(error));
    return stateFromRecord(record);
  }

  async end(identity: RequestIdentity): Promise<TerminalTurnState> {
    const key = turnKey(identity);
    const record = this.records.get(key);
    if (!record) return closedState(null);
    this.renewSurface(record);
    if (record.sessionId) this.renewActive(record);
    this.scheduleExpiry(key, record);
    await this.persist();
    return stateFromRecord(record);
  }

  dispose(): void {
    for (const record of this.records.values()) this.clearExpiry(record);
    this.records.clear();
    this.surfaceKeys.clear();
    this.activationTails.clear();
  }

  private async restore(): Promise<void> {
    if (!this.statePath) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as unknown;
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return;
      throw error;
    }
    if (!isPersistedTurnState(parsed)) throw new Error('Persisted Terminal turn state is invalid.');
    const now = Date.now();
    for (const persisted of parsed.records) {
      const record = normalizePersistedRecord(parsed.version, persisted, now, this.surfaceRetentionMs);
      if (record.sessionId && record.activeExpiresAt !== null && record.activeExpiresAt <= now) {
        const expiredSession = record.sessionId;
        record.sessionId = null;
        record.activeExpiresAt = null;
        await this.safeClose(record.identity, expiredSession);
      }
      if (!record.sessionId && record.surfaceExpiresAt <= now) continue;
      const key = turnKey(record.identity);
      const existing = this.records.get(key);
      if (existing && existing.surfaceExpiresAt >= record.surfaceExpiresAt) continue;
      if (existing) this.surfaceKeys.delete(existing.surfaceId);
      this.records.set(key, record);
      this.surfaceKeys.set(record.surfaceId, key);
      this.scheduleExpiry(key, record);
    }
    await this.persist();
  }

  private async withActivationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.activationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.activationTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.activationTails.get(key) === tail) this.activationTails.delete(key);
    }
  }

  private renewSurface(record: TerminalTurnRecord): void {
    record.surfaceExpiresAt = Date.now() + this.surfaceRetentionMs;
  }

  private renewActive(record: TerminalTurnRecord): void {
    record.activeExpiresAt = Date.now() + this.activeLeaseMs;
  }

  private scheduleExpiry(key: string, record: TerminalTurnRecord): void {
    this.clearExpiry(record);
    const deadlines = [record.surfaceExpiresAt];
    if (record.sessionId && record.activeExpiresAt !== null) deadlines.push(record.activeExpiresAt);
    const deadline = Math.min(...deadlines);
    record.expiryTimer = setTimeout(() => {
      void this.expireDue(key, record).catch((error) => logPersistenceFailure(error));
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(1, deadline - Date.now())));
    record.expiryTimer.unref?.();
  }

  private async expireDue(key: string, record: TerminalTurnRecord): Promise<void> {
    if (this.records.get(key) !== record) return;
    this.clearExpiry(record);
    const now = Date.now();
    let changed = false;

    if (record.sessionId && record.activeExpiresAt !== null && record.activeExpiresAt <= now) {
      const sessionId = record.sessionId;
      record.sessionId = null;
      record.activeExpiresAt = null;
      changed = true;
      await this.safeClose(record.identity, sessionId);
    }

    if (!record.sessionId && record.surfaceExpiresAt <= now) {
      this.records.delete(key);
      this.surfaceKeys.delete(record.surfaceId);
      changed = true;
    } else {
      this.scheduleExpiry(key, record);
    }

    if (changed) await this.persist();
  }

  private clearExpiry(record: TerminalTurnRecord): void {
    if (!record.expiryTimer) return;
    clearTimeout(record.expiryTimer);
    record.expiryTimer = undefined;
  }

  private async persist(): Promise<void> {
    if (!this.statePath) return;
    this.persistenceTail = this.persistenceTail.catch(() => undefined).then(() => this.writeState());
    await this.persistenceTail;
  }

  private async writeState(): Promise<void> {
    if (!this.statePath) return;
    const state: PersistedTurnStateV2 = {
      version: 2,
      records: [...this.records.values()].map((record) => ({
        identity: { ...record.identity },
        surfaceId: record.surfaceId,
        sessionId: record.sessionId,
        surfaceExpiresAt: record.surfaceExpiresAt,
        activeExpiresAt: record.activeExpiresAt,
      })),
    };
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.statePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async safeClose(identity: RequestIdentity, sessionId: string): Promise<void> {
    try {
      await this.closeTerminal(identity, sessionId);
    } catch (error) {
      if (isErrorCode(error, 'SESSION_NOT_FOUND')) return;
      console.error(JSON.stringify({
        level: 'error',
        event: 'terminal.turn_cleanup_failed',
        terminal_session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

function normalizePersistedRecord(
  version: 1 | 2,
  persisted: PersistedTurnRecordV1 | PersistedTurnRecordV2,
  now: number,
  surfaceRetentionMs: number,
): TerminalTurnRecord {
  if (version === 1) {
    const legacy = persisted as PersistedTurnRecordV1;
    return {
      identity: { ...legacy.identity },
      surfaceId: legacy.surfaceId,
      sessionId: legacy.sessionId,
      surfaceExpiresAt: now + surfaceRetentionMs,
      activeExpiresAt: legacy.sessionId ? legacy.expiresAt : null,
      expiryTimer: undefined,
    };
  }
  const current = persisted as PersistedTurnRecordV2;
  return {
    identity: { ...current.identity },
    surfaceId: current.surfaceId,
    sessionId: current.sessionId,
    surfaceExpiresAt: current.surfaceExpiresAt,
    activeExpiresAt: current.activeExpiresAt,
    expiryTimer: undefined,
  };
}

function stateFromRecord(record: TerminalTurnRecord): TerminalTurnState {
  return {
    surface_id: record.surfaceId,
    surface_open: true,
    surface_active: record.sessionId !== null,
    session_id: record.sessionId,
  };
}

function closedState(surfaceId: string | null): TerminalTurnState {
  return {
    surface_id: surfaceId,
    surface_open: false,
    surface_active: false,
    session_id: null,
  };
}

function turnKey(identity: RequestIdentity): string {
  const sessionKey = identity.mcpSessionId ?? identity.chatgptSessionId ?? 'client-session';
  return [identity.userId, identity.clientId, sessionKey].join('\u0000');
}

function samePrincipal(left: RequestIdentity, right: RequestIdentity): boolean {
  return left.userId === right.userId && left.clientId === right.clientId;
}

function isPersistedTurnState(value: unknown): value is PersistedTurnState {
  if (!value || typeof value !== 'object') return false;
  const state = value as { version?: unknown; records?: unknown };
  if (!Array.isArray(state.records)) return false;
  if (state.version === 1) return state.records.every(isPersistedTurnRecordV1);
  if (state.version === 2) return state.records.every(isPersistedTurnRecordV2);
  return false;
}

function isPersistedIdentity(identity: unknown): identity is RequestIdentity {
  if (!identity || typeof identity !== 'object') return false;
  const candidate = identity as Partial<RequestIdentity>;
  return typeof candidate.userId === 'string'
    && typeof candidate.clientId === 'string'
    && isExecutionProfile(candidate.executionProfile);
}

function isPersistedTurnRecordV1(value: unknown): value is PersistedTurnRecordV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PersistedTurnRecordV1>;
  return Boolean(
    isPersistedIdentity(record.identity)
    && typeof record.surfaceId === 'string'
    && (record.sessionId === null || typeof record.sessionId === 'string')
    && typeof record.expiresAt === 'number'
    && Number.isFinite(record.expiresAt),
  );
}

function isPersistedTurnRecordV2(value: unknown): value is PersistedTurnRecordV2 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PersistedTurnRecordV2>;
  return Boolean(
    isPersistedIdentity(record.identity)
    && typeof record.surfaceId === 'string'
    && (record.sessionId === null || typeof record.sessionId === 'string')
    && typeof record.surfaceExpiresAt === 'number'
    && Number.isFinite(record.surfaceExpiresAt)
    && (record.activeExpiresAt === null || (typeof record.activeExpiresAt === 'number' && Number.isFinite(record.activeExpiresAt))),
  );
}

function isExecutionProfile(value: unknown): value is RequestIdentity['executionProfile'] {
  return value === 'read-only' || value === 'developer' || value === 'owner-full';
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code);
}

function logPersistenceFailure(error: unknown): void {
  console.error(JSON.stringify({
    level: 'error',
    event: 'terminal.turn_persist_failed',
    error: error instanceof Error ? error.message : String(error),
  }));
}
