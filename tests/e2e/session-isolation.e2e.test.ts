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

describe('MCP transport session isolation', () => {
  it('keeps concurrent conversations from replacing or closing each other surfaces and PTYs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-mcp-isolation-e2e-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const developmentToken = 'isolation-e2e-development-token-0123456789';
    const enrollmentToken = 'isolation-e2e-enrollment-token-0123456789';
    const ownerId = 'isolation-e2e-user';
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
    let clientA: Client | undefined;
    let clientB: Client | undefined;
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
        displayName: 'Isolation computer',
      })).toBe('enrolled');

      const agent = new LocalTerminalAgent({
        agentId: identity.agentId,
        displayName: 'Isolation computer',
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

      clientA = await connectClient(baseUrl, developmentToken, 'conversation-a');
      clientB = await connectClient(baseUrl, developmentToken, 'conversation-b');
      const surfaceA = structured(await clientA.callTool({ name: 'terminal_surface', arguments: {} }));
      const surfaceB = structured(await clientB.callTool({ name: 'terminal_surface', arguments: {} }));
      const surfaceIdA = stringField(surfaceA, 'surface_id');
      const surfaceIdB = stringField(surfaceB, 'surface_id');
      expect(surfaceIdA).not.toBe(surfaceIdB);

      const startedA = structured(await clientA.callTool({
        name: 'terminal_start',
        arguments: { surface_id: surfaceIdA, agent_id: identity.agentId, cwd: workspace, shell: 'bash', cols: 80, rows: 24 },
      }));
      const startedB = structured(await clientB.callTool({
        name: 'terminal_start',
        arguments: { surface_id: surfaceIdB, agent_id: identity.agentId, cwd: workspace, shell: 'bash', cols: 80, rows: 24 },
      }));
      const sessionIdA = stringField(startedA, 'session_id');
      const sessionIdB = stringField(startedB, 'session_id');
      expect(sessionIdA).not.toBe(sessionIdB);
      expect(startedA.surface_id).toBe(surfaceIdA);
      expect(startedB.surface_id).toBe(surfaceIdB);

      const aSurfaceAfterB = structured(await clientA.callTool({
        name: 'terminal_surface_status', arguments: { surface_id: surfaceIdA, session_id: sessionIdA },
      }));
      const bSurfaceAfterA = structured(await clientB.callTool({
        name: 'terminal_surface_status', arguments: { surface_id: surfaceIdB, session_id: sessionIdB },
      }));
      expect(aSurfaceAfterB).toEqual(expect.objectContaining({ surface_open: true, surface_active: true, session_id: sessionIdA }));
      expect(bSurfaceAfterA).toEqual(expect.objectContaining({ surface_open: true, surface_active: true, session_id: sessionIdB }));

      const aYield = structured(await clientA.callTool({ name: 'terminal_turn_close', arguments: { surface_id: surfaceIdA } }));
      expect(aYield).toEqual(expect.objectContaining({ surface_open: true, surface_active: true, session_id: sessionIdA }));
      const aStatusWhileWaiting = structured(await clientA.callTool({ name: 'terminal_status', arguments: { session_id: sessionIdA } }));
      const bStatus = structured(await clientB.callTool({ name: 'terminal_status', arguments: { session_id: sessionIdB } }));
      expect(aStatusWhileWaiting.status).toBe('running');
      expect(bStatus.status).toBe('running');

      await clientB.callTool({
        name: 'terminal_write', arguments: { session_id: sessionIdB, text: "printf '__B_STILL_ALIVE__\\n'\r" },
      });
      expect(await readUntil(clientB, sessionIdB, Number(startedB.cursor ?? 0), '__B_STILL_ALIVE__')).toContain('__B_STILL_ALIVE__');

      await clientA.callTool({ name: 'terminal_close', arguments: { session_id: sessionIdA } });
      await waitUntil(async () => {
        const aStatus = structured(await clientA!.callTool({ name: 'terminal_status', arguments: { session_id: sessionIdA } }));
        return aStatus.status === 'closed';
      });
      await clientB.callTool({ name: 'terminal_close', arguments: { session_id: sessionIdB } });
      await clientB.callTool({ name: 'terminal_turn_close', arguments: { surface_id: surfaceIdB } });
    } finally {
      await clientA?.close().catch(() => undefined);
      await clientB?.close().catch(() => undefined);
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
