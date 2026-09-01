import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Embedded SQLite is the fastest durable store for this single-process MCP server:
 * zero network hop, WAL for concurrent readers, synchronous API for simple transactions.
 * Live agent/session maps remain process-local; the registry is the durability boundary.
 */
export type TerminalDatabase = DatabaseSync;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

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

CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices(owner_id);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_agent ON devices(agent_id);
`;

export function resolveSqlitePath(registryPath: string): string {
  if (registryPath.endsWith('.sqlite') || registryPath.endsWith('.db')) return registryPath;
  if (registryPath.endsWith('.json')) return `${registryPath.slice(0, -'.json'.length)}.sqlite`;
  return `${registryPath}.sqlite`;
}

export function openTerminalDatabase(dbPath: string): TerminalDatabase {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);
  const version = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (!version) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
  }
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    // Best-effort on platforms that ignore mode bits.
  }
  // WAL sidecar files may appear after first write; ignore chmod failures there.
  for (const suffix of ['-wal', '-shm']) {
    try {
      chmodSync(`${dbPath}${suffix}`, 0o600);
    } catch {
      // not created yet
    }
  }
  return db;
}

export function closeTerminalDatabase(db: TerminalDatabase | undefined): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    // already closed
  }
}
