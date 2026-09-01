import { describe, expect, it } from 'vitest';
import { MemoryLiveStore } from '../../packages/mcp-server/src/live-store.js';
import type { Agent, TerminalEvent, TerminalSession } from '../../packages/protocol/src/index.js';

function sampleAgent(id: string): Agent {
  const now = new Date().toISOString();
  return {
    agent_id: id,
    execution_profile: 'developer',
    hostname: 'host',
    display_name: 'Laptop',
    platform: 'linux',
    architecture: 'x64',
    online: true,
    capabilities: { pty: true, resize: true, signals: ['SIGINT'], shells: ['bash'], resume: false },
    connected_at: now,
    last_seen: now,
  };
}

function sampleSession(sessionId: string, agentId: string, userId: string): TerminalSession {
  const now = new Date().toISOString();
  return {
    session_id: sessionId,
    agent_id: agentId,
    user_id: userId,
    execution_profile: 'developer',
    cwd: '/tmp',
    shell: 'bash',
    cols: 120,
    rows: 30,
    status: 'running',
    created_at: now,
    last_activity_at: now,
    exit_code: null,
  };
}

describe('MemoryLiveStore', () => {
  it('persists sessions and agent presence across logical instance views', async () => {
    const store = new MemoryLiveStore('instance-a');
    const agent = sampleAgent('agent-1');
    await store.setAgentPresence('agent-1', {
      agent,
      deviceId: 'device-1',
      ownerId: 'owner-a',
      online: true,
      lastSeenMs: Date.now(),
      instanceId: store.instanceId,
    });

    const listed = await store.listAgentPresenceByOwner('owner-a');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.agent.agent_id).toBe('agent-1');

    const session = sampleSession('sess-1', 'agent-1', 'owner-a');
    await store.putSession('sess-1', {
      ownerId: 'owner-a',
      agentId: 'agent-1',
      session,
      events: [],
      latestSequence: 0,
      earliestSequence: 1,
      retainedBytes: 0,
    });

    const ids = await store.listSessionIdsByOwner('owner-a');
    expect(ids).toContain('sess-1');
    const loaded = await store.getSession('sess-1');
    expect(loaded?.session?.session_id).toBe('sess-1');

    await store.clearAgentPresence('agent-1', store.instanceId);
    expect(await store.getAgentPresence('agent-1')).toBeUndefined();
    await store.close();
  });

  it('publishes session events to local subscribers', async () => {
    const store = new MemoryLiveStore();
    const event: TerminalEvent = {
      event_id: 'evt-1',
      session_id: 'sess-1',
      sequence: 1,
      timestamp: new Date().toISOString(),
      actor: 'system',
      event_type: 'terminal.stdout',
      data: { text: 'hi' },
    };

    const received = new Promise<TerminalEvent>((resolve) => {
      store.subscribeSessionEvents('sess-1', resolve);
    });
    await store.publishSessionEvent('sess-1', event);
    await expect(received).resolves.toMatchObject({ sequence: 1, data: { text: 'hi' } });
    await store.close();
  });

  it('routes agent commands through the local handler', async () => {
    const store = new MemoryLiveStore();
    store.onLocalAgentCommand(async (agentId, requestId, command) => {
      expect(agentId).toBe('agent-1');
      expect(requestId).toBe('req-1');
      return { ok: true, command };
    });
    const result = await store.requestAgentCommand('agent-1', 'req-1', { type: 'ping' }, 1000);
    expect(result).toEqual({ ok: true, command: { type: 'ping' } });
    await store.close();
  });

  it('merges sessions monotonically by sequence', async () => {
    const { mergeSessionRecords } = await import('../../packages/mcp-server/src/live-store.js');
    const lower = {
      ownerId: 'o',
      agentId: 'a',
      events: [],
      latestSequence: 2,
      earliestSequence: 1,
      retainedBytes: 0,
    };
    const higher = {
      ownerId: 'o',
      agentId: 'a',
      events: [],
      latestSequence: 5,
      earliestSequence: 1,
      retainedBytes: 10,
    };
    expect(mergeSessionRecords(higher, lower).latestSequence).toBe(5);
    expect(mergeSessionRecords(lower, higher).latestSequence).toBe(5);
  });

  it('ignores stale agent presence with older lastSeenMs', async () => {
    const store = new MemoryLiveStore();
    const agent = sampleAgent('agent-1');
    await store.setAgentPresence('agent-1', {
      agent,
      deviceId: 'd1',
      ownerId: 'owner-a',
      online: true,
      lastSeenMs: 2_000,
      instanceId: 'i-1',
    });
    await store.setAgentPresence('agent-1', {
      agent,
      deviceId: 'd1',
      ownerId: 'owner-a',
      online: false,
      lastSeenMs: 1_000,
      instanceId: 'i-2',
    });
    const presence = await store.getAgentPresence('agent-1');
    expect(presence?.online).toBe(true);
    expect(presence?.lastSeenMs).toBe(2_000);
    await store.close();
  });
});
