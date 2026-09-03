import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { terminalEventSchema, type TerminalEvent } from '@terminal/protocol';

export interface SessionEventJournalOptions {
  dir: string;
  maxBytesPerSession: number;
  retentionMs: number;
  includeCommandInput?: boolean;
  sweepIntervalMs?: number;
}

export interface JournalReadResult {
  events: TerminalEvent[];
  eventBytes: number[];
  earliestSequence: number | undefined;
  latestSequence: number | undefined;
}

interface JournalWriter {
  fd: number;
  path: string;
  rotatedPath: string;
  bytes: number;
}

export class SessionEventJournal {
  private readonly writers = new Map<string, JournalWriter>();
  private readonly segmentMaxBytes: number;
  private readonly includeCommandInput: boolean;
  private readonly sweepIntervalMs: number;
  private lastSweepAt = 0;
  private closed = false;

  constructor(private readonly options: SessionEventJournalOptions) {
    this.segmentMaxBytes = Math.max(1024, Math.floor(options.maxBytesPerSession / 2));
    this.includeCommandInput = options.includeCommandInput ?? false;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    try { chmodSync(options.dir, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
  }

  append(event: TerminalEvent): void {
    if (this.closed) return;
    const stored = event.event_type === 'command.input' && !this.includeCommandInput
      ? { ...event, data: { redacted: true } }
      : event;
    const line = `${JSON.stringify(stored)}\n`;
    const lineBytes = Buffer.byteLength(line);
    let writer = this.writerFor(event.session_id);
    if (writer.bytes > 0 && writer.bytes + lineBytes > this.segmentMaxBytes) {
      writer = this.rotate(event.session_id, writer);
    }
    writeSync(writer.fd, line, undefined, 'utf8');
    writer.bytes += lineBytes;
  }

  read(sessionId: string): JournalReadResult {
    const { path, rotatedPath } = this.paths(sessionId);
    const events: TerminalEvent[] = [];
    const eventBytes: number[] = [];
    for (const file of [rotatedPath, path]) {
      if (!existsSync(file)) continue;
      let content: string;
      try { content = readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of content.split('\n')) {
        if (!line) continue;
        try {
          const event = terminalEventSchema.parse(JSON.parse(line));
          events.push(event);
          eventBytes.push(Buffer.byteLength(JSON.stringify(event)));
        } catch {
          // Ignore corrupt/incomplete records. A later valid sequence gap is
          // rejected by the caller rather than returning misleading replay.
        }
      }
    }
    events.sort((a, b) => a.sequence - b.sequence);
    if (events.length > 1) {
      const sizes = new Map(events.map((event, index) => [event.event_id, eventBytes[index] ?? 0]));
      eventBytes.length = 0;
      for (const event of events) eventBytes.push(sizes.get(event.event_id) ?? Buffer.byteLength(JSON.stringify(event)));
    }
    return {
      events,
      eventBytes,
      earliestSequence: events[0]?.sequence,
      latestSequence: events.at(-1)?.sequence,
    };
  }

  sweep(now = Date.now()): void {
    if (this.closed) return;
    if (now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;
    let names: string[];
    try { names = readdirSync(this.options.dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(this.options.dir, name);
      try {
        if (now - statSync(path).mtimeMs < this.options.retentionMs) continue;
        const sessionId = name.replace(/(?:\.1)?\.jsonl$/, '');
        const writer = this.writers.get(sessionId);
        if (writer && (writer.path === path || writer.rotatedPath === path)) continue;
        rmSync(path, { force: true });
      } catch {
        // Best-effort retention cleanup must never destabilize terminal I/O.
      }
    }
  }

  release(sessionId: string): void {
    const writer = this.writers.get(sessionId);
    if (!writer) return;
    try { closeSync(writer.fd); } catch { /* already closed */ }
    this.writers.delete(sessionId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const writer of this.writers.values()) {
      try { closeSync(writer.fd); } catch { /* already closed */ }
    }
    this.writers.clear();
  }

  private writerFor(sessionId: string): JournalWriter {
    const existing = this.writers.get(sessionId);
    if (existing) return existing;
    const paths = this.paths(sessionId);
    const fd = openSync(paths.path, 'a', 0o600);
    const writer: JournalWriter = {
      fd,
      path: paths.path,
      rotatedPath: paths.rotatedPath,
      bytes: fstatSync(fd).size,
    };
    this.writers.set(sessionId, writer);
    return writer;
  }

  private rotate(sessionId: string, writer: JournalWriter): JournalWriter {
    try { closeSync(writer.fd); } catch { /* already closed */ }
    rmSync(writer.rotatedPath, { force: true });
    if (existsSync(writer.path)) renameSync(writer.path, writer.rotatedPath);
    const fd = openSync(writer.path, 'a', 0o600);
    const next = { ...writer, fd, bytes: 0 };
    this.writers.set(sessionId, next);
    return next;
  }

  private paths(sessionId: string): { path: string; rotatedPath: string } {
    // Session IDs are generated UUIDs, but encode defensively so a custom
    // runtime cannot turn a journal filename into a path traversal primitive.
    const safe = encodeURIComponent(sessionId);
    return {
      path: join(this.options.dir, `${safe}.jsonl`),
      rotatedPath: join(this.options.dir, `${safe}.1.jsonl`),
    };
  }
}
