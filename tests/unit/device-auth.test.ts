import { createServer } from 'node:http';
import { stat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { gatewayAuthChallengeSchema, gatewayChallengePayload } from '../../packages/protocol/src/index.js';
import { DeviceIdentity } from '../../packages/local-agent/src/device-identity.js';
import { DeviceRegistry } from '../../packages/mcp-server/src/device-registry.js';
import { AgentGateway } from '../../packages/mcp-server/src/gateway.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('device identity and enrollment', () => {
  it('persists owner-only Ed25519 identity, verifies proof, rotates key, and revokes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-device-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const identityPath = join(root, 'agent', 'device.json');
    const registryPath = join(root, 'server', 'devices.json');
    const enrollmentToken = 'unit-enrollment-token-0123456789abcdef';

    const identity = await DeviceIdentity.loadOrCreate(identityPath);
    const originalDeviceId = identity.deviceId;
    const originalPublicKey = identity.publicKey;
    expect((await stat(identityPath)).mode & 0o777).toBe(0o600);

    const registry = await DeviceRegistry.load(registryPath, enrollmentToken);
    const enrolled = await registry.enroll({
      device_id: identity.deviceId,
      agent_id: identity.agentId,
      owner_id: 'owner-a',
      public_key: identity.publicKey,
      display_name: 'Developer laptop',
    }, enrollmentToken);
    expect(enrolled.status).toBe('enrolled');
    expect(enrolled.record.key_version).toBe(1);
    expect(registry.databasePath).toBe(join(root, 'server', 'devices.sqlite'));
    expect((await stat(registry.databasePath!)).mode & 0o777).toBe(0o600);

    const challenge = {
      type: 'auth.challenge' as const,
      nonce: '3dc36b79-f5e3-4940-a0a8-5f75ba8f15da',
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 10_000).toISOString(),
    };
    const originalSignature = identity.signChallenge(challenge);
    expect(registry.verifyProof(
      identity.deviceId,
      gatewayChallengePayload(identity.deviceId, challenge.nonce, challenge.issued_at),
      originalSignature,
    ).owner_id).toBe('owner-a');

    const rotatedIdentity = await DeviceIdentity.loadOrCreate(identityPath, true);
    expect(rotatedIdentity.deviceId).toBe(originalDeviceId);
    expect(rotatedIdentity.publicKey).not.toBe(originalPublicKey);
    const rotated = await registry.enroll({
      device_id: rotatedIdentity.deviceId,
      agent_id: rotatedIdentity.agentId,
      owner_id: 'owner-a',
      public_key: rotatedIdentity.publicKey,
    }, enrollmentToken);
    expect(rotated.status).toBe('rotated');
    expect(rotated.record.key_version).toBe(2);

    expect(() => registry.verifyProof(
      originalDeviceId,
      gatewayChallengePayload(originalDeviceId, challenge.nonce, challenge.issued_at),
      originalSignature,
    )).toThrow(/signature verification failed/i);

    const rotatedChallenge = { ...challenge, nonce: '5ed34f4f-a338-46ab-a584-1029e97e3ec7' };
    const rotatedSignature = rotatedIdentity.signChallenge(rotatedChallenge);
    expect(registry.verifyProof(
      originalDeviceId,
      gatewayChallengePayload(originalDeviceId, rotatedChallenge.nonce, rotatedChallenge.issued_at),
      rotatedSignature,
    ).key_version).toBe(2);

    await registry.revoke(originalDeviceId, enrollmentToken);
    expect(() => registry.requireActive(originalDeviceId)).toThrow(/revoked/i);
  });

  it('rejects replay of an already-used signed gateway challenge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-replay-'));
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
    if (!address || typeof address === 'string') throw new Error('Unable to allocate replay-test server port.');

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/agent`, {
      headers: { 'x-terminal-device-id': identity.deviceId },
    });
    cleanup.push(() => socket.close());
    const challenge = gatewayAuthChallengeSchema.parse(await nextMessage(socket));
    const proof = {
      type: 'auth.proof' as const,
      device_id: identity.deviceId,
      nonce: challenge.nonce,
      issued_at: challenge.issued_at,
      signature: identity.signChallenge(challenge),
    };
    socket.send(JSON.stringify(proof));
    expect(await nextMessage(socket)).toMatchObject({ type: 'auth.accepted' });

    const closed = waitForClose(socket);
    socket.send(JSON.stringify(proof));
    expect(await closed).toBe(1008);
  });

  it('rejects enrollment with the wrong administrative token and owner reassignment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-device-deny-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const identity = await DeviceIdentity.loadOrCreate(join(root, 'device.json'));
    const registry = await DeviceRegistry.load(join(root, 'devices.json'), 'correct-enrollment-token');

    await expect(registry.enroll({
      device_id: identity.deviceId,
      agent_id: identity.agentId,
      owner_id: 'owner-a',
      public_key: identity.publicKey,
    }, 'wrong-token')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await registry.enroll({
      device_id: identity.deviceId,
      agent_id: identity.agentId,
      owner_id: 'owner-a',
      public_key: identity.publicKey,
    }, 'correct-enrollment-token');
    await expect(registry.enroll({
      device_id: identity.deviceId,
      agent_id: identity.agentId,
      owner_id: 'owner-b',
      public_key: identity.publicKey,
    }, 'correct-enrollment-token')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(registry.enroll({
      device_id: identity.deviceId,
      agent_id: 'agent-rebound',
      owner_id: 'owner-a',
      public_key: identity.publicKey,
    }, 'correct-enrollment-token')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('supports local-admin enrollment without exposing the bootstrap token and preserves immutable bindings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-device-local-admin-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const identity = await DeviceIdentity.loadOrCreate(join(root, 'device.json'));
    const registryPath = join(root, 'devices.json');
    const registry = await DeviceRegistry.load(registryPath);

    const enrolled = await registry.enrollLocalAdmin({
      device_id: identity.deviceId,
      agent_id: identity.agentId,
      owner_id: 'owner-a',
      public_key: identity.publicKey,
      display_name: 'Local admin laptop',
    });
    expect(enrolled.status).toBe('enrolled');
    expect(enrolled.record.owner_id).toBe('owner-a');
    expect(registry.databasePath).toBe(join(root, 'devices.sqlite'));
    expect((await stat(registry.databasePath!)).mode & 0o777).toBe(0o600);

    await expect(registry.enrollLocalAdmin({
      device_id: identity.deviceId,
      agent_id: identity.agentId,
      owner_id: 'owner-b',
      public_key: identity.publicKey,
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('migrates version-1 device registries to an explicit immutable agent binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-device-migrate-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const identity = await DeviceIdentity.loadOrCreate(join(root, 'device.json'));
    const registryPath = join(root, 'devices.json');
    const now = new Date().toISOString();
    await writeFile(registryPath, `${JSON.stringify({
      version: 1,
      devices: [{
        device_id: identity.deviceId,
        owner_id: 'owner-a',
        public_key: identity.publicKey,
        status: 'active',
        key_version: 1,
        enrolled_at: now,
        updated_at: now,
      }],
    })}\n`, { mode: 0o600 });

    const registry = await DeviceRegistry.load(registryPath, 'migration-token');
    expect(registry.requireActive(identity.deviceId).agent_id).toBe(identity.agentId);
    const persisted = JSON.parse(await readFile(registryPath, 'utf8')) as { version: number; devices: Array<{ agent_id?: string }> };
    expect(persisted.version).toBe(2);
    expect(persisted.devices[0]?.agent_id).toBe(identity.agentId);

    // SQLite is source of truth after migration; re-open must not depend on JSON alone.
    registry.close();
    const reloaded = await DeviceRegistry.load(registryPath, 'migration-token');
    expect(reloaded.requireActive(identity.deviceId).agent_id).toBe(identity.agentId);
    expect(reloaded.databasePath).toMatch(/devices\.sqlite$/);
    reloaded.close();
  });

  it('persists enrollment across process reloads via SQLite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-device-sqlite-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const identity = await DeviceIdentity.loadOrCreate(join(root, 'device.json'));
    const registryPath = join(root, 'devices.sqlite');
    const token = 'sqlite-token';

    const registry = await DeviceRegistry.load(registryPath, token);
    await registry.enroll({
      device_id: identity.deviceId,
      agent_id: identity.agentId,
      owner_id: 'owner-a',
      public_key: identity.publicKey,
      display_name: 'SQLite box',
    }, token);
    registry.close();

    const again = await DeviceRegistry.load(registryPath, token);
    const record = again.requireActive(identity.deviceId);
    expect(record.owner_id).toBe('owner-a');
    expect(record.display_name).toBe('SQLite box');
    expect(record.key_version).toBe(1);
    again.close();
  });
});

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
