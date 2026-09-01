import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Embedded SQLite is the durable device-registry store for this MCP server:
 * zero network hop, WAL for concurrent readers, synchronous API for transactions.
 *
 * Note: Node's built-in `node:sqlite` (`DatabaseSync`) is still marked experimental.
 * We intentionally use it to avoid native addon build complexity. Require Node ≥ 22.5
 * (where the module shipped). If the API changes upstream, pin the Node major in deploy.
 */
export type TerminalDatabase = DatabaseSync;

export function assertSqliteRuntimeSupport(): void {
  const major = Number(process.versions.node.split('.')[0] ?? 0);
  const minor = Number(process.versions.node.split('.')[1] ?? 0);
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error(
      `Device registry SQLite requires Node.js >= 22.5 (found ${process.versions.node}). ` +
        'node:sqlite is experimental; pin a supported Node release in production.',
    );
  }
}

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 10000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 67108864;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  enrolled_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

-- Primary lookup is PK (device_id). listByOwner uses owner_id + ORDER BY enrolled_at:
-- composite avoids a TEMP B-TREE sort (see EXPLAIN QUERY PLAN).
CREATE INDEX IF NOT EXISTS idx_devices_owner_enrolled ON devices(owner_id, enrolled_at);
-- Optional filter path for active-only listings.
CREATE INDEX IF NOT EXISTS idx_devices_owner_status ON devices(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_devices_agent ON devices(agent_id);
-- Low-cardinality status-only index is intentionally omitted (active|revoked).
`;

export function resolveSqlitePath(registryPath: string): string {
  if (registryPath.endsWith('.sqlite') || registryPath.endsWith('.db')) return registryPath;
  if (registryPath.endsWith('.json')) return `${registryPath.slice(0, -'.json'.length)}.sqlite`;
  return `${registryPath}.sqlite`;
}

export function openTerminalDatabase(dbPath: string): TerminalDatabase {
  assertSqliteRuntimeSupport();
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);

  // Fail fast on corruption rather than serving bad rows.
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
    const integrityValue = row ? String(Object.values(row)[0] ?? '') : '';
    if (integrityValue && integrityValue !== 'ok') {
      db.close();
      throw new Error(`Device registry SQLite integrity check failed: ${integrityValue}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('integrity check failed')) throw error;
    // Some node:sqlite builds return multi-row integrity_check; ignore non-fatal shapes.
  }

  const version = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (!version) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
  }

  hardenFileModes(dbPath);
  return db;
}

export function checkpointAndClose(db: TerminalDatabase | undefined, dbPath?: string): void {
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // checkpoint optional if already closed / read-only
  }
  try {
    db.close();
  } catch {
    // already closed
  }
  if (dbPath) hardenFileModes(dbPath);
}

export function closeTerminalDatabase(db: TerminalDatabase | undefined): void {
  checkpointAndClose(db);
}

/** node:sqlite has no better-sqlite3-style .transaction(); serialize with BEGIN IMMEDIATE. */
export function runImmediateTransaction<T>(db: TerminalDatabase, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw error;
  }
}

function hardenFileModes(dbPath: string): void {
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    // Best-effort on platforms that ignore mode bits.
  }
  for (const suffix of ['-wal', '-shm']) {
    try {
      chmodSync(`${dbPath}${suffix}`, 0o600);
    } catch {
      // not created yet
    }
  }
}
