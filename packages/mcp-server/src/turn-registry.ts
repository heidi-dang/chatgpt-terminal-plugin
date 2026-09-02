import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RequestIdentity } from './service.js';

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
  expiresAt: number;
  leaseTimer: NodeJS.Timeout | undefined;
}

interface PersistedTurnRecord {
  identity: RequestIdentity;
  surfaceId: string;
  sessionId: string | null;
  expiresAt: number;
}

interface PersistedTurnState {
  version: 1;
  records: PersistedTurnRecord[];
}

type CloseTerminal = (identity: RequestIdentity, sessionId: string) => Promise<void>;

export class TerminalTurnRegistry {
  private readonly records = new Map<string, TerminalTurnRecord>();
  private readonly surfaceKeys = new Map<string, string>();
  private readonly activationTails = new Map<string, Promise<void>>();
  private persistenceTail = Promise.resolve();

  constructor(
    private readonly closeTerminal: CloseTerminal,
    private readonly leaseMs: number,
    private readonly statePath?: string,
  ) {}

  static async load(closeTerminal: CloseTerminal, leaseMs: number, statePath?: string): Promise<TerminalTurnRegistry> {
    const registry = new TerminalTurnRegistry(closeTerminal, leaseMs, statePath);
    await registry.restore();
    return registry;
  }

  async begin(identity: RequestIdentity): Promise<TerminalTurnState> {
    const key = turnKey(identity);
    const existing = this.records.get(key);
    if (existing) {
      existing.identity = { ...existing.identity, ...identity };
      this.armLease(key, existing);
      await this.persist();
      return stateFromRecord(existing);
    }

    const record: TerminalTurnRecord = {
      identity: { ...identity },
      surfaceId: randomUUID(),
      sessionId: null,
      expiresAt: Date.now() + this.leaseMs,
      leaseTimer: undefined,
    };
    this.records.set(key, record);
    this.surfaceKeys.set(record.surfaceId, key);
    this.armLease(key, record);
    await this.persist();
    return stateFromRecord(record);
  }

  async recover(identity: RequestIdentity, surfaceId?: string): Promise<TerminalTurnState> {
    const current = this.records.get(turnKey(identity));
    if (current) return stateFromRecord(current);

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
    if (candidate.expiresAt <= Date.now()) {
      await this.closeRecord(oldKey, candidate);
      await this.persist();
      return closedState(surfaceId ?? candidate.surfaceId);
    }

    const newKey = turnKey(identity);
    const conflict = this.records.get(newKey);
    if (conflict && conflict !== candidate) return closedState(surfaceId ?? candidate.surfaceId);
    if (oldKey !== newKey) this.records.delete(oldKey);
    candidate.identity = { ...candidate.identity, ...identity };
    this.records.set(newKey, candidate);
    this.surfaceKeys.set(candidate.surfaceId, newKey);
    this.armLease(newKey, candidate);
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
      this.armLease(key, record);
      await this.persist();
      return stateFromRecord(record);
    });
  }

  async clearActive(identity: RequestIdentity): Promise<TerminalTurnState> {
    const key = turnKey(identity);
    const record = this.records.get(key);
    if (!record) return closedState(null);
    const sessionId = record.sessionId;
    record.sessionId = null;
    if (sessionId) await this.safeClose(record.identity, sessionId);
    this.armLease(key, record);
    await this.persist();
    return stateFromRecord(record);
  }

  deactivate(identity: RequestIdentity, sessionId: string): TerminalTurnState {
    const key = turnKey(identity);
    const record = this.records.get(key);
    if (!record || record.sessionId !== sessionId) return record ? stateFromRecord(record) : closedState(null);
    record.sessionId = null;
    this.armLease(key, record);
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
    this.armLease(key, record);
    void this.persist().catch((error) => logPersistenceFailure(error));
    return stateFromRecord(record);
  }

  async end(identity: RequestIdentity): Promise<TerminalTurnState> {
    return this.clearActive(identity);
  }

  dispose(): void {
    for (const record of this.records.values()) this.clearLease(record);
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
      if (persisted.expiresAt <= now) continue;
      const record: TerminalTurnRecord = { ...persisted, identity: { ...persisted.identity }, leaseTimer: undefined };
      const key = turnKey(record.identity);
      const existing = this.records.get(key);
      if (existing && existing.expiresAt >= record.expiresAt) continue;
      if (existing) this.surfaceKeys.delete(existing.surfaceId);
      this.records.set(key, record);
      this.surfaceKeys.set(record.surfaceId, key);
      this.armLease(key, record, false);
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

  private armLease(key: string, record: TerminalTurnRecord, renew = true): void {
    this.clearLease(record);
    const now = Date.now();
    if (renew) record.expiresAt = now + this.leaseMs;
    const remainingMs = Math.max(1, record.expiresAt - now);
    record.leaseTimer = setTimeout(() => {
      const current = this.records.get(key);
      if (current !== record) return;
      this.records.delete(key);
      this.surfaceKeys.delete(record.surfaceId);
      this.clearLease(record);
      if (record.sessionId) void this.safeClose(record.identity, record.sessionId);
      void this.persist().catch((error) => logPersistenceFailure(error));
    }, remainingMs);
    record.leaseTimer.unref?.();
  }

  private clearLease(record: TerminalTurnRecord): void {
    if (!record.leaseTimer) return;
    clearTimeout(record.leaseTimer);
    record.leaseTimer = undefined;
  }

  private async closeRecord(key: string, record: TerminalTurnRecord): Promise<void> {
    if (this.records.get(key) === record) this.records.delete(key);
    this.surfaceKeys.delete(record.surfaceId);
    this.clearLease(record);
    if (record.sessionId) await this.safeClose(record.identity, record.sessionId);
  }

  private async persist(): Promise<void> {
    if (!this.statePath) return;
    this.persistenceTail = this.persistenceTail.catch(() => undefined).then(() => this.writeState());
    await this.persistenceTail;
  }

  private async writeState(): Promise<void> {
    if (!this.statePath) return;
    const state: PersistedTurnState = {
      version: 1,
      records: [...this.records.values()].map((record) => ({
        identity: { ...record.identity },
        surfaceId: record.surfaceId,
        sessionId: record.sessionId,
        expiresAt: record.expiresAt,
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
  const state = value as Partial<PersistedTurnState>;
  return state.version === 1 && Array.isArray(state.records) && state.records.every(isPersistedTurnRecord);
}

function isPersistedTurnRecord(value: unknown): value is PersistedTurnRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PersistedTurnRecord>;
  return Boolean(
    record.identity
    && typeof record.identity.userId === 'string'
    && typeof record.identity.clientId === 'string'
    && isExecutionProfile(record.identity.executionProfile)
    && typeof record.surfaceId === 'string'
    && (record.sessionId === null || typeof record.sessionId === 'string')
    && typeof record.expiresAt === 'number'
    && Number.isFinite(record.expiresAt),
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
