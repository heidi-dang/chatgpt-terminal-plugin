import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger, redactText } from '../../packages/mcp-server/src/audit.js';
import { StreamTokenService } from '../../packages/mcp-server/src/stream-token.js';
import { LocalTerminalAgent } from '../../packages/local-agent/src/index.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('security and lifecycle hardening', () => {
  it('scopes, revokes, and expires terminal stream capabilities', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const service = new StreamTokenService('stream-token-secret-0123456789abcdef', 60);
    const issued = service.issue('user-a', 'session-a');
    expect(service.verify(issued.token, 'session-a')).toMatchObject({ sub: 'user-a', sid: 'session-a' });
    expect(() => service.verify(issued.token, 'session-b')).toThrow(/invalid or expired/i);

    const revoked = service.issue('user-a', 'session-a');
    service.revoke(revoked.token);
    expect(() => service.verify(revoked.token, 'session-a')).toThrow(/invalid or expired/i);

    const expiring = service.issue('user-a', 'session-a');
    vi.advanceTimersByTime(61_000);
    expect(() => service.verify(expiring.token, 'session-a')).toThrow(/invalid or expired/i);
  });

  it('prunes expired revoked stream-token tombstones', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const service = new StreamTokenService('stream-token-secret-0123456789abcdef', 60);
    const revoked = service.issue('user-a', 'session-a');
    service.revoke(revoked.token);
    const revokedMap = (service as unknown as { revoked: Map<string, number> }).revoked;
    expect(revokedMap.size).toBe(1);
    vi.advanceTimersByTime(61_000);
    service.issue('user-a', 'session-b');
    expect(revokedMap.size).toBe(0);
  });

  it('redacts credentials and prunes expired transcript entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-audit-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const auditPath = join(root, 'audit.jsonl');
    const transcriptPath = join(root, 'transcript.jsonl');
    const logger = new AuditLogger(auditPath, transcriptPath);

    await logger.record({
      action: 'terminal_write',
      user_id: 'user-a',
      authorization: 'allow',
      input: { text: 'access_token=super-secret-value Bearer abcdefghijklmnopqrstuvwxyz' },
    });
    const audit = await readFile(auditPath, 'utf8');
    expect(audit).not.toContain('super-secret-value');
    expect(audit).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(audit).toContain('[REDACTED]');
    expect(redactText('password=hunter2')).not.toContain('hunter2');

    const now = Date.now();
    await writeFile(transcriptPath, [
      JSON.stringify({ timestamp: new Date(now - 10 * 24 * 60 * 60_000).toISOString(), data: 'old' }),
      JSON.stringify({ timestamp: new Date(now).toISOString(), data: 'new' }),
      '',
    ].join('\n'), { mode: 0o600 });
    expect(await logger.pruneTranscript(7)).toBe(1);
    const transcript = await readFile(transcriptPath, 'utf8');
    expect(transcript).not.toContain('old');
    expect(transcript).toContain('new');
  });

  it('keeps flush pending for writes enqueued while an earlier tail is draining', async () => {
    const logger = new AuditLogger('/tmp/audit-flush-race.jsonl', undefined);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let secondStarted!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const secondStartedPromise = new Promise<void>((resolve) => { secondStarted = resolve; });
    const internal = logger as unknown as {
      fileTails: Map<string, Promise<void>>;
      enqueue(path: string | undefined, operation: () => Promise<void>): Promise<void>;
    };
    internal.fileTails.set('/tmp/audit-flush-race.jsonl', first);

    let flushed = false;
    const flushing = logger.flush().then(() => { flushed = true; });
    const second = internal.enqueue('/tmp/audit-flush-race.jsonl', async () => {
      secondStarted();
      await secondGate;
    });

    releaseFirst();
    await secondStartedPromise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(flushed).toBe(false);

    releaseSecond();
    await Promise.all([flushing, second]);
    expect(flushed).toBe(true);
  });

  it('restores owner-only permissions when an audit file is externally rotated and recreated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-audit-rotate-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const auditPath = join(root, 'audit.jsonl');
    const rotatedPath = join(root, 'audit.jsonl.1');
    const logger = new AuditLogger(auditPath, undefined);

    await logger.record({ action: 'terminal_status', user_id: 'user-a', authorization: 'allow' });
    expect((await stat(auditPath)).mode & 0o777).toBe(0o600);

    await rename(auditPath, rotatedPath);
    await writeFile(auditPath, '', { mode: 0o644 });
    expect((await stat(auditPath)).mode & 0o777).toBe(0o644);

    await logger.record({ action: 'terminal_read', user_id: 'user-a', authorization: 'allow' });

    expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(auditPath, 'utf8')).toContain('terminal_read');
    expect(await readFile(rotatedPath, 'utf8')).toContain('terminal_status');
  });

  it('leaves transcript evidence untouched when prune staging fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-transcript-prune-fail-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const transcriptPath = join(root, 'transcript.jsonl');
    const logger = new AuditLogger(undefined, transcriptPath);
    const now = Date.now();
    const original = [
      JSON.stringify({ timestamp: new Date(now - 10 * 24 * 60 * 60_000).toISOString(), data: 'old' }),
      JSON.stringify({ timestamp: new Date(now).toISOString(), data: 'new' }),
      '',
    ].join('\n');
    await writeFile(transcriptPath, original, { mode: 0o600 });
    await mkdir(`${transcriptPath}.prune.tmp`);

    await expect(logger.pruneTranscript(7)).rejects.toBeTruthy();
    expect(await readFile(transcriptPath, 'utf8')).toBe(original);
  });

  it('serializes transcript appends with retention pruning so fresh events are not lost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-transcript-race-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const transcriptPath = join(root, 'nested', 'transcript.jsonl');
    await writeFile(join(root, 'seed.jsonl'), '', { mode: 0o600 });
    const logger = new AuditLogger(undefined, transcriptPath);

    const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString();
    await logger.transcript({
      user_id: 'user-a', agent_id: 'agent-a', terminal_session_id: 'session-a', sequence: 1,
      event_type: 'terminal.stdout', data: { text: 'fresh-before-prune' },
    });
    const existing = await readFile(transcriptPath, 'utf8');
    await writeFile(transcriptPath, `${JSON.stringify({ timestamp: oldTimestamp, data: 'old' })}\n${existing}`, { mode: 0o600 });

    const appendOne = logger.transcript({
      user_id: 'user-a', agent_id: 'agent-a', terminal_session_id: 'session-a', sequence: 2,
      event_type: 'terminal.stdout', data: { text: 'fresh-one' },
    });
    const prune = logger.pruneTranscript(7);
    const appendTwo = logger.transcript({
      user_id: 'user-a', agent_id: 'agent-a', terminal_session_id: 'session-a', sequence: 3,
      event_type: 'terminal.stdout', data: { text: 'fresh-two' },
    });
    await Promise.all([appendOne, prune, appendTwo]);

    const content = await readFile(transcriptPath, 'utf8');
    expect(content).not.toContain('"data":"old"');
    expect(content).toContain('fresh-before-prune');
    expect(content).toContain('fresh-one');
    expect(content).toContain('fresh-two');
  });

  it('releases closed PTY/session records after the post-mortem retention window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-closed-retention-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const agent = new LocalTerminalAgent({
      agentId: 'agent-retention',
      allowedWorkspaceRoots: [root],
      executionProfile: 'developer',
      shells: ['bash'],
      idleTimeoutMs: 10_000,
      maxLifetimeMs: 10_000,
      closedSessionRetentionMs: 60,
      sweepIntervalMs: 10,
    });
    cleanup.push(() => agent.shutdown());
    const started = agent.start('user-a', {
      agent_id: 'agent-retention', cwd: root, shell: 'bash', cols: 80, rows: 24,
    }, 'developer');
    expect(agent.close(started.session.session_id).session.status).toBe('closing');
    await waitUntil(() => agent.status(started.session.session_id).session.status === 'closed', 2000);

    await waitUntil(() => {
      try {
        agent.status(started.session.session_id);
        return false;
      } catch (error) {
        return error instanceof Error && /not found/i.test(error.message);
      }
    }, 2000);
  });

  it('closes abandoned PTYs after their configured idle timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-idle-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const agent = new LocalTerminalAgent({
      agentId: 'agent-idle',
      allowedWorkspaceRoots: [root],
      executionProfile: 'developer',
      shells: ['bash'],
      idleTimeoutMs: 200,
      maxLifetimeMs: 10_000,
      sweepIntervalMs: 50,
    });
    cleanup.push(() => agent.shutdown());
    const started = agent.start('user-a', {
      agent_id: 'agent-idle', cwd: root, shell: 'bash', cols: 80, rows: 24,
    }, 'developer');

    await waitUntil(() => agent.status(started.session.session_id).session.status === 'closed', 4000);
    const events = agent.readEvents(started.session.session_id, 0, 256 * 1024).events;
    expect(events.some((event) => event.event_type === 'session.closed' && event.data.reason === 'idle_timeout')).toBe(true);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for lifecycle condition.');
}
