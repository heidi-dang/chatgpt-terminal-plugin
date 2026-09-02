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
  leaseTimer: NodeJS.Timeout | undefined;
}

type CloseTerminal = (identity: RequestIdentity, sessionId: string) => Promise<void>;

export class TerminalTurnRegistry {
  private readonly records = new Map<string, TerminalTurnRecord>();
  private readonly activationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly closeTerminal: CloseTerminal,
    private readonly leaseMs: number,
  ) {}

  begin(identity: RequestIdentity): TerminalTurnState {
    const key = turnKey(identity);
    const existing = this.records.get(key);
    if (existing) {
      this.armLease(key, existing);
      return stateFromRecord(existing);
    }

    const record: TerminalTurnRecord = {
      identity: { ...identity },
      surfaceId: randomUUID(),
      sessionId: null,
      leaseTimer: undefined,
    };
    this.records.set(key, record);
    this.armLease(key, record);
    return stateFromRecord(record);
  }


  recover(identity: RequestIdentity, surfaceId: string): TerminalTurnState {
    const key = turnKey(identity);
    const current = this.records.get(key);
    if (current) {
      if (current.surfaceId !== surfaceId) return closedState(surfaceId);
      this.armLease(key, current);
      return stateFromRecord(current);
    }

    const record: TerminalTurnRecord = {
      identity: { ...identity },
      surfaceId,
      sessionId: null,
      leaseTimer: undefined,
    };
    this.records.set(key, record);
    this.armLease(key, record);
    return stateFromRecord(record);
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
      return stateFromRecord(record);
    });
  }

  async clearActive(identity: RequestIdentity): Promise<TerminalTurnState> {
    const record = this.records.get(turnKey(identity));
    if (!record) return closedState(null);
    const sessionId = record.sessionId;
    record.sessionId = null;
    if (sessionId) await this.safeClose(record.identity, sessionId);
    this.armLease(turnKey(identity), record);
    return stateFromRecord(record);
  }

  deactivate(identity: RequestIdentity, sessionId: string): TerminalTurnState {
    const record = this.records.get(turnKey(identity));
    if (!record || record.sessionId !== sessionId) return record ? stateFromRecord(record) : closedState(null);
    record.sessionId = null;
    this.armLease(turnKey(identity), record);
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
    return stateFromRecord(record);
  }

  async end(identity: RequestIdentity): Promise<TerminalTurnState> {
    return this.clearActive(identity);
  }

  dispose(): void {
    for (const record of this.records.values()) this.clearLease(record);
    this.records.clear();
    this.activationTails.clear();
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

  private armLease(key: string, record: TerminalTurnRecord): void {
    this.clearLease(record);
    record.leaseTimer = setTimeout(() => {
      const current = this.records.get(key);
      if (current !== record) return;
      this.records.delete(key);
      this.clearLease(record);
      if (record.sessionId) {
        void this.safeClose(record.identity, record.sessionId);
      }
    }, this.leaseMs);
    record.leaseTimer.unref?.();
  }

  private clearLease(record: TerminalTurnRecord): void {
    if (!record.leaseTimer) return;
    clearTimeout(record.leaseTimer);
    record.leaseTimer = undefined;
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
  return [identity.userId, identity.clientId, identity.mcpSessionId].join('\u0000');
}


function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code);
}
