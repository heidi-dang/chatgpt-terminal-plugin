import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { LocalTerminalAgent } from '../../packages/local-agent/src/index.js';
import { AgentGatewayClient } from '../../packages/local-agent/src/gateway-client.js';
import { DeviceIdentity, enrollDevice } from '../../packages/local-agent/src/device-identity.js';
import { loadConfig } from '../../packages/mcp-server/src/config.js';
import { createTerminalHttpRuntime, type TerminalHttpRuntime } from '../../packages/mcp-server/src/http.js';

describe('MCP deployment restart recovery', () => {
  it('recovers the exact surface when MCP restarts between terminal_surface and terminal_start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-mcp-restart-e2e-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const developmentToken = 'restart-e2e-development-token-0123456789';
    const enrollmentToken = 'restart-e2e-enrollment-token-0123456789';
    const ownerId = 'restart-e2e-user';
    const config = loadConfig({
      NODE_ENV: 'test',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(port),
      MCP_PUBLIC_URL: `${baseUrl}/mcp`,
      MCP_AUTH_MODE: 'development',
      MCP_DEVELOPMENT_TOKEN: developmentToken,
      DEVELOPMENT_USER_ID: ownerId,
      OAUTH_REQUIRED_SCOPES: 'terminal',
      STREAM_TOKEN_SECRET: developmentToken,
      AGENT_GATEWAY_PATH: '/agent',
      AGENT_ENROLLMENT_PATH: '/agent/enroll',
      AGENT_DEVICE_REGISTRY_PATH: join(root, 'devices.json'),
      AGENT_ENROLLMENT_TOKEN: enrollmentToken,
      TERMINAL_TURN_STATE_PATH: join(root, 'terminal-turns.json'),
      TERMINAL_TURN_LEASE_MS: '60000',
      TERMINAL_MAX_SESSIONS_PER_USER: '4',
      TERMINAL_MAX_SESSIONS_PER_AGENT: '4',
      TERMINAL_IDLE_TIMEOUT_MS: '60000',
      TERMINAL_MAX_LIFETIME_MS: '120000',
      TERMINAL_SWEEP_INTERVAL_MS: '1000',
      AGENT_REQUEST_TIMEOUT_MS: '5000',
      REQUESTS_PER_MINUTE: '120',
    });

    let runtime: TerminalHttpRuntime | undefined;
    let firstClient: Client | undefined;
    let secondClient: Client | undefined;
    let gatewayClient: AgentGatewayClient | undefined;
    let gatewayRun: Promise<void> | undefined;

    try {
      runtime = await createTerminalHttpRuntime(config);
      await listen(runtime, port);

      const identity = await DeviceIdentity.loadOrCreate(join(root, 'device.json'));
      expect(await enrollDevice({
        identity,
        enrollmentUrl: `${baseUrl}/agent/enroll`,
        enrollmentToken,
        ownerId,
        displayName: 'Restart recovery computer',
      })).toBe('enrolled');

      const agent = new LocalTerminalAgent({
        agentId: identity.agentId,
        displayName: 'Restart recovery computer',
        allowedWorkspaceRoots: [workspace],
        executionProfile: 'owner-full',
        shells: ['bash'],
        bufferHighWaterBytes: 1024 * 1024,
        maxEventBytes: 64 * 1024,
        idleTimeoutMs: 60_000,
        maxLifetimeMs: 120_000,
        sweepIntervalMs: 1000,
      });
      gatewayClient = new AgentGatewayClient(agent, {
        url: `ws://127.0.0.1:${port}/agent`,
        identity,
        heartbeatMs: 250,
        reconnectMaxMs: 500,
        outboundHighWaterBytes: 1024 * 1024,
        maxInflightEvents: 16,
      });
      gatewayRun = gatewayClient.start();
      await waitUntil(() => runtime!.gateway.listAgents(ownerId).some((candidate) => candidate.agent_id === identity.agentId && candidate.online));

      firstClient = await connectClient(baseUrl, developmentToken, 'restart-client-before');
      const surface = structured(await firstClient.callTool({ name: 'terminal_surface', arguments: {} }));
      const surfaceId = stringField(surface, 'surface_id');
      expect(surface.surface_open).toBe(true);
      expect(surface.session_id).toBeNull();

      await firstClient.close();
      firstClient = undefined;
      await runtime.close();
      runtime = undefined;

      runtime = await createTerminalHttpRuntime(config);
      await listen(runtime, port);
      await waitUntil(() => runtime!.gateway.listAgents(ownerId).some((candidate) => candidate.agent_id === identity.agentId && candidate.online), 8_000);

      secondClient = await connectClient(baseUrl, developmentToken, 'restart-client-after');
      const started = structured(await secondClient.callTool({
        name: 'terminal_start',
        arguments: {
          surface_id: surfaceId,
          agent_id: identity.agentId,
          cwd: workspace,
          shell: 'bash',
          cols: 80,
          rows: 24,
        },
      }));
      const sessionId = stringField(started, 'session_id');
      expect(started.surface_id).toBe(surfaceId);
      expect(started.status).toBe('running');

      await secondClient.callTool({
        name: 'terminal_write',
        arguments: { session_id: sessionId, text: "printf '__RESTART_RECOVERED__\\n'\r" },
      });
      const output = await readUntil(secondClient, sessionId, Number(started.cursor ?? 0), '__RESTART_RECOVERED__');
      expect(output).toContain('__RESTART_RECOVERED__');

      const closed = structured(await secondClient.callTool({
        name: 'terminal_turn_close',
        arguments: { surface_id: surfaceId },
      }));
      expect(closed).toEqual(expect.objectContaining({ surface_id: surfaceId, surface_open: true, surface_active: false, session_id: null }));
    } finally {
      await firstClient?.close().catch(() => undefined);
      await secondClient?.close().catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      gatewayClient?.stop();
      if (gatewayRun) await Promise.race([gatewayRun.catch(() => undefined), delay(2_000)]);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function connectClient(baseUrl: string, token: string, name: string): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    authProvider: { token: async () => token },
  });
  await client.connect(transport);
  return client;
}

async function listen(runtime: TerminalHttpRuntime, port: number): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    runtime.httpServer.once('error', rejectListen);
    runtime.httpServer.listen(port, '127.0.0.1', () => {
      runtime.httpServer.off('error', rejectListen);
      resolveListen();
    });
  });
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a TCP port.');
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return port;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for condition.');
}

async function readUntil(client: Client, sessionId: string, after: number, needle: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  let cursor = after;
  let output = '';
  while (Date.now() < deadline) {
    const result = structured(await client.callTool({
      name: 'terminal_read',
      arguments: { session_id: sessionId, after: cursor, max_bytes: 32768, wait_ms: 250 },
    }));
    cursor = Number(result.next_cursor ?? cursor);
    output += String(result.output ?? '');
    if (output.includes(needle)) return output;
  }
  throw new Error(`Timed out waiting for ${needle}. Output: ${output}`);
}

function structured(result: CallToolResult): Record<string, unknown> {
  if (result.isError) throw new Error(result.content.map((item) => item.type === 'text' ? item.text : item.type).join('\n'));
  if (!result.structuredContent || typeof result.structuredContent !== 'object') throw new Error('MCP tool result has no structured content.');
  return result.structuredContent as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') throw new Error(`${key} is not a string.`);
  return field;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
