import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceIdentity } from '../../packages/local-agent/src/device-identity.js';
import { loadConfig, type ServerConfig } from '../../packages/mcp-server/src/config.js';
import { createTerminalHttpRuntime, type TerminalHttpRuntime } from '../../packages/mcp-server/src/http.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('device enrollment HTTP persistence failures', () => {
  it('returns 503 for registry storage failure without trusting the rejected device', async () => {
    const setup = await startRuntime('terminal-http-enrollment-persist-');
    await mkdir(`${setup.registryPath}.tmp`);

    const response = await enroll(setup);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'device_registry_unavailable' });
    expect(setup.runtime.deviceRegistry.get(setup.identity.deviceId)).toBeUndefined();
  });

  it('keeps malformed public keys in the 400 client-error class', async () => {
    const setup = await startRuntime('terminal-http-enrollment-invalid-key-');

    const response = await enroll(setup, { public_key: 'x'.repeat(32) });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_ARGUMENT', retryable: false });
    expect(setup.runtime.deviceRegistry.get(setup.identity.deviceId)).toBeUndefined();
  });

  it('returns 503 for revocation storage failure without revoking the in-memory device', async () => {
    const setup = await startRuntime('terminal-http-revocation-persist-');
    expect((await enroll(setup)).status).toBe(201);
    await mkdir(`${setup.registryPath}.tmp`);

    const response = await fetch(`${setup.baseUrl}${setup.config.agentEnrollmentPath}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-terminal-enrollment-token': setup.enrollmentToken },
      body: JSON.stringify({ device_id: setup.identity.deviceId }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'device_registry_unavailable' });
    expect(setup.runtime.deviceRegistry.requireActive(setup.identity.deviceId).status).toBe('active');
  });
});

interface RuntimeSetup {
  runtime: TerminalHttpRuntime;
  config: ServerConfig;
  registryPath: string;
  enrollmentToken: string;
  identity: DeviceIdentity;
  baseUrl: string;
}

async function startRuntime(prefix: string): Promise<RuntimeSetup> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const registryPath = join(root, 'server', 'devices.json');
  const enrollmentToken = 'http-enrollment-token-0123456789';
  const identity = await DeviceIdentity.loadOrCreate(join(root, 'device.json'));
  const config = loadConfig({
    NODE_ENV: 'test', MCP_HOST: '127.0.0.1', MCP_PORT: '8787',
    MCP_PUBLIC_URL: 'http://127.0.0.1:8787/mcp', MCP_AUTH_MODE: 'development',
    MCP_DEVELOPMENT_TOKEN: 'http-enrollment-development-token-0123456789',
    STREAM_TOKEN_SECRET: 'http-enrollment-stream-secret-0123456789abcdef',
    AGENT_DEVICE_REGISTRY_PATH: registryPath, AGENT_ENROLLMENT_TOKEN: enrollmentToken,
    REQUESTS_PER_MINUTE: '1000',
  });
  const runtime = await createTerminalHttpRuntime(config);
  cleanup.push(() => runtime.close());
  await new Promise<void>((resolve, reject) => {
    runtime.httpServer.once('error', reject);
    runtime.httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = runtime.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate enrollment test port.');
  return { runtime, config, registryPath, enrollmentToken, identity, baseUrl: `http://127.0.0.1:${address.port}` };
}

function enroll(setup: RuntimeSetup, override: { public_key?: string } = {}): Promise<Response> {
  return fetch(`${setup.baseUrl}${setup.config.agentEnrollmentPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-terminal-enrollment-token': setup.enrollmentToken },
    body: JSON.stringify({
      device_id: setup.identity.deviceId,
      agent_id: setup.identity.agentId,
      owner_id: 'owner-a',
      public_key: override.public_key ?? setup.identity.publicKey,
    }),
  });
}
