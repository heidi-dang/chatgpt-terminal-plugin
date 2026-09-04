import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { gatewayAuthChallengeSchema } from '../../packages/protocol/src/index.js';
import { DeviceIdentity } from '../../packages/local-agent/src/device-identity.js';
import { DeviceRegistry } from '../../packages/mcp-server/src/device-registry.js';
import { AgentGateway } from '../../packages/mcp-server/src/gateway.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('gateway replay integrity', () => {
  it('releases final server session records after the configured retention window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-gateway-retention-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const registry = await DeviceRegistry.load(join(root, 'devices.json'), 'enrollment-token');
    const gateway = new AgentGateway({
      requestTimeoutMs: 1000,
      maxRetainedBytesPerSession: 1024 * 1024,
      closedSessionRetentionMs: 60,
      sessionSweepIntervalMs: 10,
      deviceRegistry: registry,
      authChallengeTtlMs: 5000,
    });
    cleanup.push(() => gateway.closeAll());
    const now = new Date().toISOString();
    const sessions = (gateway as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set('session-final', {
      ownerId: 'owner-a',
      agentId: 'agent-a',
      session: {
        session_id: 'session-final', agent_id: 'agent-a', user_id: 'owner-a', execution_profile: 'developer',
        cwd: '/workspace', shell: 'bash', cols: 80, rows: 24, status: 'closed',
        created_at: now, last_activity_at: now, exit_code: 0,
      },
      events: [], eventSizes: [], eventHead: 0, latestSequence: 0, earliestSequence: 1, retainedBytes: 0,
    });
    expect(gateway.listSessions('owner-a')).toHaveLength(1);
    await waitUntil(() => gateway.listSessions('owner-a').length === 0, 2000);
  });

  it('resumes from the agent retained boundary and rejects forward event gaps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-gateway-replay-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const identity = await DeviceIdentity.loadOrCreate(join(root, 'device.json'));
    const registry = await DeviceRegistry.load(join(root, 'devices.json'), 'enrollment-token');
    await registry.enroll({
      device_id: identity.deviceId,
      agent_id: identity.agentId,
      owner_id: 'owner-a',
      public_key: identity.publicKey,
    }, 'enrollment-token');

    const gateway = new AgentGateway({
      requestTimeoutMs: 1000,
      maxRetainedBytesPerSession: 1024 * 1024,
      closedSessionRetentionMs: 60_000,
      sessionSweepIntervalMs: 10_000,
      deviceRegistry: registry,
      authChallengeTtlMs: 5000,
    });
    cleanup.push(() => gateway.closeAll());
    const server = createServer();
    server.on('upgrade', (request, socket, head) => gateway.handleUpgrade(request, socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unable to allocate gateway replay-test port.');

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/agent`, {
      headers: { 'x-terminal-device-id': identity.deviceId },
    });
    cleanup.push(() => socket.close());
    const challenge = gatewayAuthChallengeSchema.parse(await nextMessage(socket));
    socket.send(JSON.stringify({
      type: 'auth.proof',
      device_id: identity.deviceId,
      nonce: challenge.nonce,
      issued_at: challenge.issued_at,
      signature: identity.signChallenge(challenge),
    }));
    expect(await nextMessage(socket)).toMatchObject({ type: 'auth.accepted' });

    const now = new Date().toISOString();
    socket.send(JSON.stringify({
      type: 'agent.register',
      device_id: identity.deviceId,
      agent: {
        agent_id: identity.agentId,
        execution_profile: 'developer',
        hostname: 'gateway-test',
        display_name: 'Gateway test',
        platform: 'linux',
        architecture: 'x64',
        online: true,
        capabilities: { pty: true, resize: true, signals: ['SIGINT'], shells: ['bash'], resume: true },
        connected_at: now,
        last_seen: now,
      },
    }));
    socket.send(JSON.stringify({
      type: 'heartbeat',
      timestamp: now,
      telemetry: {
        cpu_load: [0.25, 0.5, 0.75],
        freemem_bytes: 1024,
        totalmem_bytes: 4096,
        uptime_seconds: 123,
        active_sessions: 2,
        active_lsp_processes: 1,
        active_code_executions: 3,
      },
    }));
    await waitUntil(() => gateway.listAgents('owner-a')[0]?.telemetry?.active_sessions === 2, 1000);
    expect(gateway.listAgents('owner-a')[0]?.telemetry).toEqual({
      cpu_load: [0.25, 0.5, 0.75],
      freemem_bytes: 1024,
      totalmem_bytes: 4096,
      uptime_seconds: 123,
      active_sessions: 2,
      active_lsp_processes: 1,
      active_code_executions: 3,
    });

    socket.send(JSON.stringify({
      type: 'agent.resume',
      agent_id: identity.agentId,
      sessions: [{
        session: {
          session_id: 'session-a',
          agent_id: identity.agentId,
          user_id: 'owner-a',
          execution_profile: 'developer',
          cwd: '/workspace',
          shell: 'bash',
          cols: 80,
          rows: 24,
          status: 'running',
          created_at: now,
          last_activity_at: now,
          exit_code: null,
        },
        cursor: 5,
        earliestCursor: 3,
      }],
    }));
    expect(await nextMessage(socket)).toEqual({
      type: 'agent.resume.ack',
      sequences: { 'session-a': 3 },
    });

    socket.send(JSON.stringify({
      type: 'event',
      event: {
        event_id: 'event-4',
        session_id: 'session-a',
        sequence: 4,
        timestamp: now,
        actor: 'agent',
        event_type: 'terminal.stdout',
        data: { text: 'four' },
      },
    }));
    expect(await nextMessage(socket)).toEqual({ type: 'ack', session_id: 'session-a', sequence: 4 });

    const closed = waitForClose(socket);
    socket.send(JSON.stringify({
      type: 'event',
      event: {
        event_id: 'event-6',
        session_id: 'session-a',
        sequence: 6,
        timestamp: now,
        actor: 'agent',
        event_type: 'terminal.stdout',
        data: { text: 'gap' },
      },
    }));
    expect(await closed).toBe(1008);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for gateway retention condition.');
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      cleanupListeners();
      try { resolve(JSON.parse(data.toString())); } catch (error) { reject(error); }
    };
    const onError = (error: Error) => { cleanupListeners(); reject(error); };
    const cleanupListeners = () => {
      socket.off('message', onMessage);
      socket.off('error', onError);
    };
    socket.once('message', onMessage);
    socket.once('error', onError);
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once('close', (code) => resolve(code));
    socket.once('error', reject);
  });
}
