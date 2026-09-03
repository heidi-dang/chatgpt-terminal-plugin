import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatewayAuthChallengeSchema } from '../../packages/protocol/src/index.js';
import { DeviceIdentity } from '../../packages/local-agent/src/device-identity.js';
import { DeviceRegistry } from '../../packages/mcp-server/src/device-registry.js';
import { AgentGateway } from '../../packages/mcp-server/src/gateway.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('gateway reconnect request ownership', () => {
  it('rejects semantic dispatch before writing to an agent that did not advertise semantic support', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-gateway-capability-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const identity = await DeviceIdentity.loadOrCreate(join(root, 'device.json'));
    const registry = await DeviceRegistry.load(join(root, 'devices.json'), 'enrollment-token');
    await registry.enroll({
      device_id: identity.deviceId, agent_id: identity.agentId, owner_id: 'owner-a', public_key: identity.publicKey,
    }, 'enrollment-token');
    const gateway = new AgentGateway({
      requestTimeoutMs: 50, maxRetainedBytesPerSession: 1024 * 1024, closedSessionRetentionMs: 60_000,
      sessionSweepIntervalMs: 10_000, deviceRegistry: registry, authChallengeTtlMs: 5_000,
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
    if (!address || typeof address === 'string') throw new Error('Unable to allocate gateway capability-test port.');

    const legacy = await connectRegistered(address.port, identity);
    cleanup.push(() => legacy.close());
    const internal = gateway as unknown as { agents: Map<string, { socket: WebSocket }> };
    await waitUntil(() => internal.agents.has(identity.agentId));
    const sendSpy = vi.spyOn(internal.agents.get(identity.agentId)!.socket, 'send');

    await expect(gateway.openSemantic('owner-a', {
      agent_id: identity.agentId, server_id: 'typescript', root: '/workspace',
    }, 'read-only')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT', retryable: false,
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });
  it('does not reject a replacement-socket request when the superseded socket closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-gateway-reconnect-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const identity = await DeviceIdentity.loadOrCreate(join(root, 'device.json'));
    const registry = await DeviceRegistry.load(join(root, 'devices.json'), 'enrollment-token');
    await registry.enroll({
      device_id: identity.deviceId, agent_id: identity.agentId, owner_id: 'owner-a', public_key: identity.publicKey,
    }, 'enrollment-token');
    const gateway = new AgentGateway({
      requestTimeoutMs: 2_000, maxRetainedBytesPerSession: 1024 * 1024, closedSessionRetentionMs: 60_000,
      sessionSweepIntervalMs: 10_000, deviceRegistry: registry, authChallengeTtlMs: 5_000,
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
    if (!address || typeof address === 'string') throw new Error('Unable to allocate gateway reconnect-test port.');

    const first = await connectRegistered(address.port, identity);
    cleanup.push(() => first.close());
    const internal = gateway as unknown as { agents: Map<string, { socket: WebSocket }> };
    await waitUntil(() => internal.agents.has(identity.agentId));
    const oldServerSocket = internal.agents.get(identity.agentId)!.socket;
    const originalClose = oldServerSocket.close.bind(oldServerSocket);
    let releaseOldClose: (() => void) | undefined;
    oldServerSocket.close = ((code?: number, data?: string | Buffer) => {
      releaseOldClose = () => originalClose(code, data);
    }) as typeof oldServerSocket.close;

    const replacement = await connectRegistered(address.port, identity);
    cleanup.push(() => replacement.close());
    await waitUntil(() => internal.agents.get(identity.agentId)?.socket !== oldServerSocket && Boolean(releaseOldClose));

    const starting = gateway.start('owner-a', {
      agent_id: identity.agentId, cwd: '/workspace', shell: 'bash', cols: 80, rows: 24,
    }, 'developer');
    const outcome = starting.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    const request = await nextMessage(replacement) as { type?: string; request_id?: string };
    expect(request.type).toBe('request');
    expect(request.request_id).toBeTruthy();

    const firstClosed = waitForClose(first);
    releaseOldClose?.();
    await firstClosed;
    const now = new Date().toISOString();
    replacement.send(JSON.stringify({
      type: 'response', request_id: request.request_id, ok: true,
      result: {
        session: {
          session_id: 'replacement-session', agent_id: identity.agentId, user_id: 'owner-a', execution_profile: 'developer',
          cwd: '/workspace', shell: 'bash', cols: 80, rows: 24, status: 'running', created_at: now, last_activity_at: now, exit_code: null,
        },
        cursor: 0,
        earliestCursor: 0,
      },
    }));

    const result = await outcome;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.session.session_id).toBe('replacement-session');
  });
});

async function connectRegistered(port: number, identity: DeviceIdentity): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/agent`, {
    headers: { 'x-terminal-device-id': identity.deviceId },
  });
  const challenge = gatewayAuthChallengeSchema.parse(await nextMessage(socket));
  socket.send(JSON.stringify({
    type: 'auth.proof', device_id: identity.deviceId, nonce: challenge.nonce, issued_at: challenge.issued_at,
    signature: identity.signChallenge(challenge),
  }));
  expect(await nextMessage(socket)).toMatchObject({ type: 'auth.accepted' });
  const now = new Date().toISOString();
  socket.send(JSON.stringify({
    type: 'agent.register', device_id: identity.deviceId,
    agent: {
      agent_id: identity.agentId, execution_profile: 'developer', hostname: 'gateway-reconnect-test', display_name: 'Gateway reconnect test',
      platform: 'linux', architecture: 'x64', online: true,
      capabilities: { pty: true, resize: true, signals: ['SIGINT'], shells: ['bash'], resume: true },
      connected_at: now, last_seen: now,
    },
  }));
  return socket;
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => { cleanupListeners(); try { resolve(JSON.parse(data.toString())); } catch (error) { reject(error); } };
    const onError = (error: Error) => { cleanupListeners(); reject(error); };
    const cleanupListeners = () => { socket.off('message', onMessage); socket.off('error', onError); };
    socket.once('message', onMessage);
    socket.once('error', onError);
  });
}

function waitForClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for gateway reconnect condition.');
}
