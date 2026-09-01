import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalEvent, TerminalSession } from '../../packages/protocol/src/index.js';
import { DeviceRegistry } from '../../packages/mcp-server/src/device-registry.js';
import { AgentGateway } from '../../packages/mcp-server/src/gateway.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('retained terminal buffers', () => {
  it('keeps gateway retention bounded and cursor-contiguous across repeated compaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-retained-buffer-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const registry = await DeviceRegistry.load(join(root, 'devices.json'), 'enrollment-token');
    const gateway = new AgentGateway({
      requestTimeoutMs: 1000,
      maxRetainedBytesPerSession: 4096,
      closedSessionRetentionMs: 60_000,
      sessionSweepIntervalMs: 10_000,
      deviceRegistry: registry,
      authChallengeTtlMs: 5000,
    });
    cleanup.push(() => gateway.closeAll());

    const now = new Date().toISOString();
    const session: TerminalSession = {
      session_id: 'session-buffer', agent_id: 'agent-buffer', user_id: 'owner-buffer', execution_profile: 'developer',
      cwd: '/workspace', shell: 'bash', cols: 80, rows: 24, status: 'running',
      created_at: now, last_activity_at: now, exit_code: null,
    };
    type InternalRecord = {
      ownerId: string;
      agentId: string;
      session: TerminalSession;
      events: TerminalEvent[];
      eventSizes: number[];
      eventHead: number;
      latestSequence: number;
      earliestSequence: number;
      retainedBytes: number;
    };
    const internal = gateway as unknown as {
      sessions: Map<string, InternalRecord>;
      storeEvent(event: TerminalEvent, agentId: string, ownerId: string): void;
    };
    internal.sessions.set(session.session_id, {
      ownerId: session.user_id,
      agentId: session.agent_id,
      session,
      events: [],
      eventSizes: [],
      eventHead: 0,
      latestSequence: 0,
      earliestSequence: 1,
      retainedBytes: 0,
    });

    for (let sequence = 1; sequence <= 5000; sequence += 1) {
      internal.storeEvent({
        event_id: `event-${sequence}`,
        session_id: session.session_id,
        sequence,
        timestamp: now,
        actor: 'agent',
        event_type: 'terminal.stdout',
        data: { text: `line-${sequence}-${'x'.repeat(80)}\n` },
      }, session.agent_id, session.user_id);
    }

    const record = internal.sessions.get(session.session_id)!;
    expect(record.earliestSequence).toBeGreaterThan(1);
    expect(record.latestSequence).toBe(5000);
    expect(record.retainedBytes).toBeLessThanOrEqual(4096);
    expect(record.events.length).toBeLessThan(1100);
    expect(record.eventSizes.length).toBe(record.events.length);
    expect(record.eventHead).toBeLessThan(1024);

    const read = await gateway.read(session.user_id, session.session_id, record.earliestSequence - 1, 64 * 1024);
    expect(read.events[0]?.sequence).toBe(record.earliestSequence);
    expect(read.events.at(-1)?.sequence).toBe(5000);
    for (let index = 1; index < read.events.length; index += 1) {
      expect(read.events[index]!.sequence).toBe(read.events[index - 1]!.sequence + 1);
    }
    await expect(gateway.read(session.user_id, session.session_id, record.earliestSequence - 2, 64 * 1024)).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
  });
});
