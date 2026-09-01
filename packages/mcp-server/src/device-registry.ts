import { createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { mkdir as mkdirAsync, readFile as readFileAsync, rename as renameAsync, writeFile as writeFileAsync, chmod as chmodAsync } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { TerminalProtocolError, deviceEnrollmentRequestSchema, type DeviceEnrollmentRequest } from '@terminal/protocol';
import {
  analyzeDatabase,
  checkpointAndClose,
  openTerminalDatabase,
  resolveSqlitePath,
  runFullIntegrityCheck,
  runImmediateTransaction,
  runSharedRegistryWrite,
  type TerminalDatabase,
} from './db.js';

const deviceRecordSchema = z.object({
  device_id: z.string().min(1),
  agent_id: z.string().min(1),
  owner_id: z.string().min(1),
  public_key: z.string().min(32),
  display_name: z.string().min(1).optional(),
  status: z.enum(['active', 'revoked']),
  key_version: z.number().int().positive(),
  enrolled_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_seen_at: z.string().datetime().optional(),
  revoked_at: z.string().datetime().optional(),
});
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;

const legacyDeviceRecordSchema = deviceRecordSchema.omit({ agent_id: true });
const registrySchema = z.union([
  z.object({ version: z.literal(1), devices: z.array(legacyDeviceRecordSchema) }),
  z.object({ version: z.literal(2), devices: z.array(deviceRecordSchema) }),
]);

type DeviceRow = {
  device_id: string;
  agent_id: string;
  owner_id: string;
  public_key: string;
  display_name: string | null;
  status: 'active' | 'revoked';
  key_version: number;
  enrolled_at: string;
  updated_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
};

export class DeviceRegistry {
  private db: TerminalDatabase | undefined;
  /** In-memory fallback when no path is configured (tests / ephemeral mode). */
  private readonly memory = new Map<string, DeviceRecord>();
  private stmts: PreparedDeviceStatements | undefined;

  private constructor(
    private readonly path: string | undefined,
    private readonly enrollmentToken: string | undefined,
    private readonly sqlitePath: string | undefined,
  ) {}

  static async load(path?: string, enrollmentToken?: string): Promise<DeviceRegistry> {
    const sqlitePath = path ? resolveSqlitePath(path) : undefined;
    const registry = new DeviceRegistry(path, enrollmentToken, sqlitePath);
    if (!path || !sqlitePath) return registry;

    await mkdirAsync(dirname(sqlitePath), { recursive: true, mode: 0o700 });
    registry.db = openTerminalDatabase(sqlitePath);
    registry.stmts = prepareStatements(registry.db);

    // One-time migration from legacy JSON registry files.
    if (path.endsWith('.json') || path !== sqlitePath) {
      await registry.migrateFromJsonIfNeeded(path);
    }

    return registry;
  }

  /** Absolute path of the durable SQLite file, if any. */
  get databasePath(): string | undefined {
    return this.sqlitePath;
  }

  get(deviceId: string): DeviceRecord | undefined {
    const record = this.readDevice(deviceId);
    return record ? { ...record } : undefined;
  }

  requireActive(deviceId: string): DeviceRecord {
    const record = this.readDevice(deviceId);
    if (!record || record.status !== 'active') {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Device is not enrolled or has been revoked.');
    }
    return record;
  }

  listByOwner(ownerId: string): DeviceRecord[] {
    if (!this.db || !this.stmts) {
      return [...this.memory.values()].filter((r) => r.owner_id === ownerId).map((r) => ({ ...r }));
    }
    const rows = this.stmts.listByOwner.all(ownerId) as DeviceRow[];
    return rows.map(rowToRecord);
  }

  /** Active devices only — uses partial / status composite indexes when present. */
  listByOwnerActive(ownerId: string): DeviceRecord[] {
    if (!this.db || !this.stmts) {
      return [...this.memory.values()]
        .filter((r) => r.owner_id === ownerId && r.status === 'active')
        .map((r) => ({ ...r }));
    }
    const rows = this.stmts.listByOwnerActive.all(ownerId) as DeviceRow[];
    return rows.map(rowToRecord);
  }

  /** Offline full integrity check (ops); not invoked on the request path. */
  checkIntegrity(): string {
    if (!this.db) return 'ok';
    return runFullIntegrityCheck(this.db);
  }

  async enroll(raw: DeviceEnrollmentRequest, presentedToken: string | undefined): Promise<{ record: DeviceRecord; status: 'enrolled' | 'rotated' }> {
    this.assertEnrollmentToken(presentedToken);
    return this.upsertValidated(raw);
  }

  async enrollLocalAdmin(raw: DeviceEnrollmentRequest): Promise<{ record: DeviceRecord; status: 'enrolled' | 'rotated' }> {
    return this.upsertValidated(raw);
  }

  private async upsertValidated(raw: DeviceEnrollmentRequest): Promise<{ record: DeviceRecord; status: 'enrolled' | 'rotated' }> {
    const input = deviceEnrollmentRequestSchema.parse(raw);
    createPublicKey(input.public_key);

    const apply = (): { record: DeviceRecord; status: 'enrolled' | 'rotated' } => {
      const existing = this.readDevice(input.device_id);
      if (existing && existing.owner_id !== input.owner_id) {
        throw new TerminalProtocolError('PERMISSION_DENIED', 'Device ownership cannot be changed by enrollment.');
      }
      if (existing && existing.agent_id !== input.agent_id) {
        throw new TerminalProtocolError('PERMISSION_DENIED', 'Device agent identity cannot be changed by enrollment.');
      }

      const now = new Date().toISOString();
      const status = existing ? 'rotated' as const : 'enrolled' as const;
      const record: DeviceRecord = {
        device_id: input.device_id,
        agent_id: input.agent_id,
        owner_id: input.owner_id,
        public_key: input.public_key,
        ...(input.display_name ? { display_name: input.display_name } : existing?.display_name ? { display_name: existing.display_name } : {}),
        status: 'active',
        key_version: (existing?.key_version ?? 0) + 1,
        enrolled_at: existing?.enrolled_at ?? now,
        updated_at: now,
        ...(existing?.last_seen_at ? { last_seen_at: existing.last_seen_at } : {}),
      };
      this.writeDevice(record);
      return { record: { ...record }, status };
    };

    if (!this.db) return apply();
    // Shared-file multi-process writers: file lock + BEGIN IMMEDIATE.
    return runSharedRegistryWrite(this.sqlitePath, this.db, apply);
  }

  async revoke(deviceId: string, presentedToken: string | undefined): Promise<void> {
    this.assertEnrollmentToken(presentedToken);
    const apply = (): void => {
      const current = this.readDevice(deviceId);
      if (!current) return;
      const now = new Date().toISOString();
      this.writeDevice({ ...current, status: 'revoked', revoked_at: now, updated_at: now });
    };
    if (!this.db) {
      apply();
      return;
    }
    runSharedRegistryWrite(this.sqlitePath, this.db, apply);
  }

  async markSeen(deviceId: string): Promise<void> {
    const now = new Date().toISOString();
    if (!this.db || !this.stmts) {
      const current = this.memory.get(deviceId);
      if (!current || current.status !== 'active') return;
      this.memory.set(deviceId, { ...current, last_seen_at: now, updated_at: now });
      return;
    }
    // Lightweight path: avoid read-modify-write races on last_seen only.
    this.stmts.markSeen.run(now, now, deviceId);
  }

  verifyProof(deviceId: string, payload: string, signatureBase64Url: string): DeviceRecord {
    const record = this.requireActive(deviceId);
    let signature: Buffer;
    try {
      signature = Buffer.from(signatureBase64Url, 'base64url');
    } catch {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Device signature is malformed.');
    }
    const valid = verify(null, Buffer.from(payload, 'utf8'), createPublicKey(record.public_key), signature);
    if (!valid) throw new TerminalProtocolError('PERMISSION_DENIED', 'Device signature verification failed.');
    return record;
  }

  close(): void {
    checkpointAndClose(this.db, this.sqlitePath);
    this.db = undefined;
    this.stmts = undefined;
  }

  private readDevice(deviceId: string): DeviceRecord | undefined {
    if (!this.db || !this.stmts) {
      const record = this.memory.get(deviceId);
      return record ? { ...record } : undefined;
    }
    const row = this.stmts.getById.get(deviceId) as DeviceRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  private writeDevice(record: DeviceRecord): void {
    if (!this.db || !this.stmts) {
      this.memory.set(record.device_id, { ...record });
      return;
    }
    // SQL WHERE on upsert enforces key_version monotonicity / revoke override.
    this.stmts.upsert.run(
      record.device_id,
      record.agent_id,
      record.owner_id,
      record.public_key,
      record.display_name ?? null,
      record.status,
      record.key_version,
      record.enrolled_at,
      record.updated_at,
      record.last_seen_at ?? null,
      record.revoked_at ?? null,
    );
  }

  private assertEnrollmentToken(presented: string | undefined): void {
    if (!this.enrollmentToken) throw new TerminalProtocolError('PERMISSION_DENIED', 'Device enrollment is disabled.');
    if (!presented) throw new TerminalProtocolError('PERMISSION_DENIED', 'Device enrollment token is required.');
    const expected = Buffer.from(this.enrollmentToken);
    const actual = Buffer.from(presented);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Device enrollment token is invalid.');
    }
  }

  private async migrateFromJsonIfNeeded(jsonPath: string): Promise<void> {
    if (!this.db) return;
    const countRow = this.db.prepare('SELECT COUNT(*) AS c FROM devices').get() as { c: number };
    if (countRow.c > 0) return;

    let raw: string;
    try {
      raw = await readFileAsync(jsonPath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }

    let parsed: z.infer<typeof registrySchema>;
    try {
      parsed = registrySchema.parse(JSON.parse(raw));
    } catch {
      // Not a legacy registry file; leave SQLite empty.
      return;
    }

    const insert = this.db.prepare(`
      INSERT INTO devices (
        device_id, agent_id, owner_id, public_key, display_name, status, key_version,
        enrolled_at, updated_at, last_seen_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    runImmediateTransaction(this.db, () => {
      for (const record of parsed.devices) {
        const agentId = parsed.version === 1 ? legacyAgentId(record.device_id) : (record as DeviceRecord).agent_id;
        insert.run(
          record.device_id,
          agentId,
          record.owner_id,
          record.public_key,
          record.display_name ?? null,
          record.status,
          record.key_version,
          record.enrolled_at,
          record.updated_at,
          record.last_seen_at ?? null,
          record.revoked_at ?? null,
        );
      }
    });

    // Planner stats after bulk import.
    analyzeDatabase(this.db);

    // Rewrite legacy JSON to version 2 for operators that still inspect the file,
    // then keep SQLite as the source of truth going forward.
    if (jsonPath.endsWith('.json')) {
      const devices = (this.db.prepare(DEVICE_SELECT_SQL).all() as DeviceRow[]).map(rowToRecord);
      const payload = registrySchema.parse({ version: 2, devices });
      const temporary = `${jsonPath}.tmp`;
      await writeFileAsync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await chmodAsync(temporary, 0o600);
      await renameAsync(temporary, jsonPath);
      await chmodAsync(jsonPath, 0o600);
    }
  }
}

function rowToRecord(row: DeviceRow): DeviceRecord {
  // Trust SQLite CHECK constraints + enrollment-time Zod validation; skip re-parse on every read.
  // (Microbench: ~56% faster than deviceRecordSchema.parse for listByOwner-scale row sets.)
  const record: DeviceRecord = {
    device_id: row.device_id,
    agent_id: row.agent_id,
    owner_id: row.owner_id,
    public_key: row.public_key,
    status: row.status,
    key_version: row.key_version,
    enrolled_at: row.enrolled_at,
    updated_at: row.updated_at,
  };
  if (row.display_name) record.display_name = row.display_name;
  if (row.last_seen_at) record.last_seen_at = row.last_seen_at;
  if (row.revoked_at) record.revoked_at = row.revoked_at;
  return record;
}

function legacyAgentId(deviceId: string): string {
  return deviceId.startsWith('device-') ? `agent-${deviceId.slice('device-'.length)}` : `agent-${deviceId}`;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

/** Explicit projection (avoid SELECT *) so column set stays intentional as the table evolves. */
const DEVICE_COLUMNS = `
  device_id, agent_id, owner_id, public_key, display_name, status, key_version,
  enrolled_at, updated_at, last_seen_at, revoked_at
`.trim();
const DEVICE_SELECT_SQL = `SELECT ${DEVICE_COLUMNS} FROM devices`;

type PreparedDeviceStatements = {
  getById: { get: (deviceId: string) => unknown };
  listByOwner: { all: (ownerId: string) => unknown[] };
  listByOwnerActive: { all: (ownerId: string) => unknown[] };
  upsert: { run: (...args: unknown[]) => unknown };
  markSeen: { run: (lastSeen: string, updated: string, deviceId: string) => unknown };
};

function prepareStatements(db: TerminalDatabase): PreparedDeviceStatements {
  return {
    getById: db.prepare(`${DEVICE_SELECT_SQL} WHERE device_id = ?`),
    listByOwner: db.prepare(
      `${DEVICE_SELECT_SQL} WHERE owner_id = ? ORDER BY enrolled_at ASC`,
    ),
    // Partial idx_devices_active_owner_enrolled + status filter for revoked-heavy owners.
    listByOwnerActive: db.prepare(
      `${DEVICE_SELECT_SQL} WHERE owner_id = ? AND status = 'active' ORDER BY enrolled_at ASC`,
    ),
    upsert: db.prepare(`
      INSERT INTO devices (
        device_id, agent_id, owner_id, public_key, display_name, status, key_version,
        enrolled_at, updated_at, last_seen_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        owner_id = excluded.owner_id,
        public_key = excluded.public_key,
        display_name = excluded.display_name,
        status = excluded.status,
        key_version = excluded.key_version,
        enrolled_at = excluded.enrolled_at,
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at,
        revoked_at = excluded.revoked_at
      WHERE excluded.key_version >= devices.key_version
         OR excluded.status = 'revoked'
    `),
    markSeen: db.prepare(`
      UPDATE devices
      SET last_seen_at = ?, updated_at = ?
      WHERE device_id = ? AND status = 'active'
    `),
  };
}
