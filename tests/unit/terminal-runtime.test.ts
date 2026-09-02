import { access, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalTerminalAgent } from '../../packages/local-agent/src/index.js';
import {
  NodePtyTerminalRuntime,
  type TerminalDisposable,
  type TerminalExit,
  type TerminalProcess,
  type TerminalRuntime,
  type TerminalRuntimeMetrics,
  type TerminalSpawnOptions,
} from '../../packages/local-agent/src/terminal-runtime.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanup.length > 0) await cleanup.pop()?.();
});

class FakeProcess implements TerminalProcess {
  readonly pid = 424242;
  readonly writes: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  interrupts = 0;
  terminates = 0;
  forceKills = 0;
  private readonly dataListeners = new Set<(text: string) => void>();
  private readonly exitListeners = new Set<(event: TerminalExit) => void>();

  write(text: string): void { this.writes.push(text); }
  resize(cols: number, rows: number): void { this.sizes.push([cols, rows]); }
  interrupt(): void { this.interrupts += 1; }
  terminate(): void { this.terminates += 1; }
  forceKill(): void { this.forceKills += 1; }
  onData(listener: (text: string) => void): TerminalDisposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }
  onExit(listener: (event: TerminalExit) => void): TerminalDisposable {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }
  emitData(text: string): void { for (const listener of this.dataListeners) listener(text); }
  emitExit(event: TerminalExit): void { for (const listener of [...this.exitListeners]) listener(event); }
}

class FakeRuntime implements TerminalRuntime {
  readonly process = new FakeProcess();
  spawnCalls: TerminalSpawnOptions[] = [];
  spawn(options: TerminalSpawnOptions): TerminalProcess {
    this.spawnCalls.push(options);
    return this.process;
  }
  metrics(): TerminalRuntimeMetrics {
    return {
      pty_create_total: this.spawnCalls.length,
      pty_create_failed_total: 0,
      active_ptys: this.spawnCalls.length > 0 ? 1 : 0,
      graceful_terminate_total: this.process.terminates,
      force_kill_total: this.process.forceKills,
      termination_escalation_total: 0,
      tree_signal_fallback_total: 0,
    };
  }
}

describe('terminal runtime hardening', () => {
  it('tracks PTY creation failures without leaking an active runtime count', () => {
    const runtime = new NodePtyTerminalRuntime({
      spawnPty: () => { throw new Error('synthetic PTY failure'); },
    });

    expect(() => runtime.spawn({
      shell: 'bash', cwd: '/', env: {}, cols: 80, rows: 24, name: 'xterm-256color',
    })).toThrow('synthetic PTY failure');
    expect(runtime.metrics()).toMatchObject({
      pty_create_total: 1,
      pty_create_failed_total: 1,
      active_ptys: 0,
    });
  });

  it('escalates a graceful termination when the PTY does not exit within the bounded grace period', async () => {
    vi.useFakeTimers();
    const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
    const kill = vi.fn();
    const raw = {
      pid: 999_999, cols: 80, rows: 24, process: 'fake', handleFlowControl: false,
      write: vi.fn(), resize: vi.fn(), clear: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill,
      onData: () => ({ dispose: vi.fn() }),
      onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
        exitListeners.add(listener);
        return { dispose: () => exitListeners.delete(listener) };
      },
    };
    const runtime = new NodePtyTerminalRuntime({
      platform: 'win32',
      terminationGraceMs: 25,
      spawnPty: () => raw as never,
    });
    const processHandle = runtime.spawn({
      shell: 'cmd.exe', cwd: '/', env: {}, cols: 80, rows: 24, name: 'xterm-256color',
    });

    processHandle.terminate();
    expect(kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(runtime.metrics()).toMatchObject({
      graceful_terminate_total: 1,
      termination_escalation_total: 1,
      force_kill_total: 1,
    });
    for (const listener of [...exitListeners]) listener({ exitCode: 1 });
    expect(runtime.metrics().active_ptys).toBe(0);
  });

  it('coalesces bursty PTY output and preserves byte-safe ordering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-runtime-coalesce-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const runtime = new FakeRuntime();
    const agent = new LocalTerminalAgent({
      agentId: 'agent-runtime-coalesce',
      allowedWorkspaceRoots: [root],
      executionProfile: 'developer',
      shells: ['bash'],
      terminalRuntime: runtime,
      outputFlushIntervalMs: 10,
      outputFlushBytes: 1024,
    });
    cleanup.push(() => agent.shutdown());
    const started = agent.start('user-a', {
      agent_id: 'agent-runtime-coalesce', cwd: root, shell: 'bash', cols: 80, rows: 24,
    }, 'developer');

    runtime.process.emitData('alpha');
    runtime.process.emitData('-');
    runtime.process.emitData('omega');
    expect(outputEvents(agent, started.session.session_id)).toHaveLength(0);
    await delay(25);

    const outputs = outputEvents(agent, started.session.session_id);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.data.text).toBe('alpha-omega');
  });

  it('splits oversized multibyte PTY bursts without corrupting UTF-8 characters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-runtime-utf8-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const runtime = new FakeRuntime();
    const agent = new LocalTerminalAgent({
      agentId: 'agent-runtime-utf8',
      allowedWorkspaceRoots: [root],
      executionProfile: 'developer',
      shells: ['bash'],
      terminalRuntime: runtime,
      outputFlushIntervalMs: 50,
      outputFlushBytes: 4,
    });
    cleanup.push(() => agent.shutdown());
    const started = agent.start('user-a', {
      agent_id: 'agent-runtime-utf8', cwd: root, shell: 'bash', cols: 80, rows: 24,
    }, 'developer');

    runtime.process.emitData('🙂🙂');
    const outputs = outputEvents(agent, started.session.session_id);
    expect(outputs.map((event) => event.data.text).join('')).toBe('🙂🙂');
    expect(outputs).toHaveLength(2);
    expect(outputs.every((event) => Buffer.byteLength(String(event.data.text)) <= 4)).toBe(true);
  });

  it('replays evicted terminal events from the opt-in journal while redacting command input by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-runtime-journal-'));
    const journalDir = join(root, '.journal');
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const runtime = new FakeRuntime();
    const agent = new LocalTerminalAgent({
      agentId: 'agent-runtime-journal',
      allowedWorkspaceRoots: [root],
      executionProfile: 'developer',
      shells: ['bash'],
      terminalRuntime: runtime,
      bufferHighWaterBytes: 700,
      outputFlushIntervalMs: 50,
      outputFlushBytes: 4,
      eventJournalDir: journalDir,
      eventJournalMaxBytes: 64 * 1024,
      eventJournalRetentionMs: 60_000,
    });
    cleanup.push(() => agent.shutdown());
    const started = agent.start('user-a', {
      agent_id: 'agent-runtime-journal', cwd: root, shell: 'bash', cols: 80, rows: 24,
    }, 'developer');

    agent.write(started.session.session_id, 'super-secret-command\r');
    for (let index = 0; index < 24; index += 1) runtime.process.emitData(String(index).padStart(4, '0'));
    expect(agent.status(started.session.session_id).earliestCursor).toBeGreaterThan(0);

    const replay = agent.readEvents(started.session.session_id, 0, 256 * 1024);
    expect(replay.events[0]?.sequence).toBe(1);
    const command = replay.events.find((event) => event.event_type === 'command.input');
    expect(command?.data).toEqual({ redacted: true });
    expect(JSON.stringify(replay.events)).not.toContain('super-secret-command');
    expect(replay.nextCursor).toBe(agent.status(started.session.session_id).cursor);
  });

  it('does not reopen a closed journal when a late PTY exit callback arrives after shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-runtime-journal-shutdown-'));
    const journalDir = join(root, '.journal');
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const runtime = new FakeRuntime();
    const agent = new LocalTerminalAgent({
      agentId: 'agent-runtime-journal-shutdown',
      allowedWorkspaceRoots: [root],
      executionProfile: 'developer',
      shells: ['bash'],
      terminalRuntime: runtime,
      outputFlushBytes: 4,
      eventJournalDir: journalDir,
      eventJournalMaxBytes: 64 * 1024,
      eventJournalRetentionMs: 60_000,
    });
    const started = agent.start('user-a', {
      agent_id: 'agent-runtime-journal-shutdown', cwd: root, shell: 'bash', cols: 80, rows: 24,
    }, 'developer');
    runtime.process.emitData('done');
    const files = (await readdir(journalDir)).filter((name) => name.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    const journalPath = join(journalDir, files[0]!);

    agent.shutdown();
    const sizeAtShutdown = (await stat(journalPath)).size;
    runtime.process.emitExit({ exitCode: 0 });
    await delay(10);

    expect((await stat(journalPath)).size).toBe(sizeAtShutdown);
    expect((await readdir(journalDir)).filter((name) => name.endsWith('.jsonl'))).toEqual(files);
    expect(agent.status(started.session.session_id).session.status).toBe('closed');
  });

  it('keeps the durable journal bounded to two rotating segments per session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-runtime-journal-bound-'));
    const journalDir = join(root, '.journal');
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const runtime = new FakeRuntime();
    const agent = new LocalTerminalAgent({
      agentId: 'agent-runtime-journal-bound',
      allowedWorkspaceRoots: [root],
      executionProfile: 'developer',
      shells: ['bash'],
      terminalRuntime: runtime,
      bufferHighWaterBytes: 1024,
      outputFlushBytes: 4,
      eventJournalDir: journalDir,
      eventJournalMaxBytes: 2048,
      eventJournalRetentionMs: 60_000,
    });
    cleanup.push(() => agent.shutdown());
    agent.start('user-a', {
      agent_id: 'agent-runtime-journal-bound', cwd: root, shell: 'bash', cols: 80, rows: 24,
    }, 'developer');
    for (let index = 0; index < 100; index += 1) runtime.process.emitData(String(index).padStart(4, '0'));

    const files = (await readdir(journalDir)).filter((name) => name.endsWith('.jsonl'));
    expect(files.length).toBeLessThanOrEqual(2);
    let totalBytes = 0;
    for (const file of files) totalBytes += (await stat(join(journalDir, file))).size;
    expect(totalBytes).toBeLessThan(4096);
  });

  it.runIf(process.platform === 'linux')('force-kills a stubborn background job even when the PTY shell exits first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-runtime-tree-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const agent = new LocalTerminalAgent({
      agentId: 'agent-runtime-tree',
      allowedWorkspaceRoots: [root],
      executionProfile: 'developer',
      shells: ['bash'],
      terminationGraceMs: 100,
      outputFlushIntervalMs: 1,
    });
    cleanup.push(() => agent.shutdown());
    const started = agent.start('user-a', {
      agent_id: 'agent-runtime-tree', cwd: root, shell: 'bash', cols: 80, rows: 24,
    }, 'developer');

    agent.write(
      started.session.session_id,
      `node -e 'process.on("SIGTERM",()=>{});require("fs").writeFileSync("ready","1");setInterval(()=>{},1000)' & child=$!; while [ ! -f ready ]; do :; done; echo $child\r`,
    );
    const childPid = await waitForPid(agent, started.session.session_id);
    await expect(access(`/proc/${childPid}`)).resolves.toBeUndefined();

    agent.close(started.session.session_id);
    await waitUntil(async () => !(await exists(`/proc/${childPid}`)), 3000);
    expect(await exists(`/proc/${childPid}`)).toBe(false);
    await waitUntil(() => agent.status(started.session.session_id).session.status === 'closed', 3000);
    expect(agent.runtimeMetrics()).toMatchObject({
      graceful_terminate_total: 1,
      termination_escalation_total: 1,
      force_kill_total: 1,
    });
  }, 10_000);
});

function outputEvents(agent: LocalTerminalAgent, sessionId: string) {
  return agent.readEvents(sessionId, 0, 256 * 1024).events.filter((event) => event.event_type === 'terminal.stdout');
}

async function waitForPid(agent: LocalTerminalAgent, sessionId: string, timeoutMs = 3000): Promise<number> {
  let output = '';
  let cursor = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const read = agent.readEvents(sessionId, cursor, 256 * 1024);
    cursor = read.nextCursor;
    for (const event of read.events) {
      if (event.event_type === 'terminal.stdout' && typeof event.data.text === 'string') output += event.data.text;
    }
    const normalized = output.replace(/\r/g, '');
    const match = normalized.match(/(?:^|\n)(\d+)\n/);
    if (match?.[1]) return Number(match[1]);
    await delay(10);
  }
  throw new Error(`Timed out waiting for background PID: ${output}`);
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for terminal runtime condition.');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
