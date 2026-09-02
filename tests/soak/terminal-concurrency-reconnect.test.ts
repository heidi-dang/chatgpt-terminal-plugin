import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalTerminalAgent } from '../../packages/local-agent/src/index.js';
import { AgentGatewayClient } from '../../packages/local-agent/src/gateway-client.js';
import { DeviceIdentity, enrollDevice } from '../../packages/local-agent/src/device-identity.js';
import { loadConfig } from '../../packages/mcp-server/src/config.js';
import { AuditLogger } from '../../packages/mcp-server/src/audit.js';
import { TerminalService, type RequestIdentity } from '../../packages/mcp-server/src/service.js';
import { createTerminalHttpRuntime, type TerminalHttpRuntime } from '../../packages/mcp-server/src/http.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('terminal concurrency/reconnect soak', () => {
  it('sustains concurrent real PTYs across repeated gateway reconnects without leaks or lost sessions', async () => {
    const clientCount = Number(process.env.TERMINAL_SOAK_CLIENTS ?? 6);
    const rounds = Number(process.env.TERMINAL_SOAK_ROUNDS ?? 20);
    const reconnectEvery = Number(process.env.TERMINAL_SOAK_RECONNECT_EVERY ?? 5);
    expect(clientCount).toBeGreaterThanOrEqual(4);
    expect(rounds).toBeGreaterThanOrEqual(10);

    const root = await mkdtemp(join(tmpdir(), 'terminal-soak-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const ownerId = 'soak-owner';
    const developmentToken = 'soak-development-token-0123456789abcdef';
    const enrollmentToken = 'soak-enrollment-token-0123456789abcdef';
    const baselineRss = process.memoryUsage().rss;
    const baselineFds = fdCount();

    const config = loadConfig({
      NODE_ENV: 'test', MCP_HOST: '127.0.0.1', MCP_PORT: String(port), MCP_PUBLIC_URL: `${baseUrl}/mcp`,
      MCP_AUTH_MODE: 'development', MCP_DEVELOPMENT_TOKEN: developmentToken, DEVELOPMENT_USER_ID: ownerId,
      OAUTH_REQUIRED_SCOPES: 'terminal', STREAM_TOKEN_SECRET: developmentToken,
      AGENT_GATEWAY_PATH: '/agent', AGENT_ENROLLMENT_PATH: '/agent/enroll',
      AGENT_DEVICE_REGISTRY_PATH: join(root, 'devices.json'), AGENT_ENROLLMENT_TOKEN: enrollmentToken,
      AGENT_AUTH_CHALLENGE_TTL_MS: '5000', TERMINAL_MAX_READ_BYTES: '65536', TERMINAL_MAX_EVENT_BYTES: '65536',
      TERMINAL_BUFFER_HIGH_WATER_BYTES: String(4 * 1024 * 1024), TERMINAL_MAX_SESSIONS_PER_USER: String(clientCount + 4),
      TERMINAL_MAX_SESSIONS_PER_AGENT: String(clientCount + 4), TERMINAL_IDLE_TIMEOUT_MS: '120000',
      TERMINAL_MAX_LIFETIME_MS: '300000', TERMINAL_SWEEP_INTERVAL_MS: '250', AGENT_REQUEST_TIMEOUT_MS: '5000',
      REQUESTS_PER_MINUTE: '10000', AUDIT_LOG_PATH: join(root, 'audit.jsonl'),
      TRANSCRIPT_LOG_PATH: join(root, 'transcript.jsonl'), TRANSCRIPT_RETENTION_DAYS: '1',
    });
    const runtime = await createTerminalHttpRuntime(config);
    await listen(runtime, port);
    cleanup.push(() => runtime.close());

    const identity = await DeviceIdentity.loadOrCreate(join(root, 'device.json'));
    await enrollDevice({ identity, enrollmentUrl: `${baseUrl}/agent/enroll`, enrollmentToken, ownerId, displayName: 'Soak computer' });
    const agent = new LocalTerminalAgent({
      agentId: identity.agentId, displayName: 'Soak computer', allowedWorkspaceRoots: [workspace], executionProfile: 'owner-full',
      shells: ['bash'], bufferHighWaterBytes: 4 * 1024 * 1024, maxEventBytes: 64 * 1024,
      idleTimeoutMs: 120_000, maxLifetimeMs: 300_000, sweepIntervalMs: 250,
    });
    cleanup.push(() => agent.shutdown());

    let gatewayClient: AgentGatewayClient | undefined;
    let gatewayRun: Promise<void> | undefined;
    const connectGateway = async () => {
      gatewayClient = new AgentGatewayClient(agent, {
        url: `ws://127.0.0.1:${port}/agent`, identity, heartbeatMs: 100, reconnectMaxMs: 300,
        outboundHighWaterBytes: 4 * 1024 * 1024, maxInflightEvents: 64,
      });
      gatewayRun = gatewayClient.start();
      await waitUntil(() => runtime.gateway.listAgents(ownerId).some((candidate) => candidate.agent_id === identity.agentId && candidate.online), 8_000);
    };
    const forceGatewayReconnect = async () => {
      type GatewayState = { socket?: { terminate(): void }; authenticated?: boolean };
      const state = gatewayClient as unknown as GatewayState | undefined;
      const previousSocket = state?.socket;
      if (!state || !previousSocket) throw new Error('Gateway socket is unavailable for reconnect soak.');
      previousSocket.terminate();
      await waitUntil(() => Boolean(state.socket && state.socket !== previousSocket && state.authenticated), 8_000);
      await waitUntil(() => runtime.gateway.listAgents(ownerId).some((candidate) => candidate.agent_id === identity.agentId && candidate.online), 8_000);
    };
    await connectGateway();
    cleanup.push(async () => { gatewayClient?.stop(); if (gatewayRun) await Promise.race([gatewayRun, delay(2_000)]); });

    const audit = new AuditLogger(config.auditLogPath, config.transcriptLogPath);
    const service = new TerminalService(runtime.gateway, config, audit);
    const requestIdentity: RequestIdentity = { userId: ownerId, clientId: 'soak-client', executionProfile: 'owner-full', chatgptSessionId: 'soak-session' };
    const sessions: Array<{ sessionId: string; cursor: number }> = [];
    for (let index = 0; index < clientCount; index += 1) {
      const started = await service.start(requestIdentity, { agent_id: identity.agentId, cwd: workspace, shell: 'bash', cols: 100, rows: 30 });
      sessions.push({ sessionId: started.session_id, cursor: started.cursor });
    }
    expect(agent.getTelemetry().active_sessions).toBe(clientCount);

    let reconnects = 0;
    let commandCount = 0;
    for (let round = 1; round <= rounds; round += 1) {
      await Promise.all(sessions.map(async (session, index) => {
        const marker = `__SOAK_${index}_${round}__`;
        await service.write(requestIdentity, { session_id: session.sessionId, text: `printf '${marker}\n'\r` });
        session.cursor = await readUntil(service, requestIdentity, session.sessionId, session.cursor, marker);
        commandCount += 1;
      }));

      if (round < rounds && round % reconnectEvery === 0) {
        await forceGatewayReconnect();
        expect(agent.getTelemetry().active_sessions).toBe(clientCount);
        reconnects += 1;
        await Promise.all(sessions.map(async ({ sessionId }) => {
          const status = await service.status(requestIdentity, sessionId);
          expect(status.status).toBe('running');
        }));
      }
    }

    expect(commandCount).toBe(clientCount * rounds);
    expect(reconnects).toBeGreaterThanOrEqual(1);
    await Promise.all(sessions.map(({ sessionId }) => service.close(requestIdentity, sessionId)));
    await Promise.all(sessions.map(({ sessionId }) => waitUntil(async () => {
      const status = await service.status(requestIdentity, sessionId);
      return status.status === 'closed';
    }, 8_000)));
    expect(agent.getTelemetry().active_sessions).toBe(0);
    for (const { sessionId } of sessions) {
      const status = await service.status(requestIdentity, sessionId);
      expect(status.status).toBe('closed');
    }

    const rssDelta = process.memoryUsage().rss - baselineRss;
    const fdDelta = fdCount() - baselineFds;
    console.log(JSON.stringify({ event: 'terminal.soak.complete', clientCount, rounds, commandCount, reconnects, rssDelta, fdDelta }));
    expect(rssDelta).toBeLessThan(256 * 1024 * 1024);
    expect(fdDelta).toBeLessThan(40);
  }, 120_000);
});

async function readUntil(service: TerminalService, identity: RequestIdentity, sessionId: string, after: number, needle: string): Promise<number> {
  const deadline = Date.now() + 8_000;
  let cursor = after;
  let output = '';
  while (Date.now() < deadline) {
    const result = await service.read(identity, { session_id: sessionId, after: cursor, max_bytes: 65536, wait_ms: 250 });
    cursor = result.next_cursor;
    output += result.output;
    if (normalizeTerminal(output).includes(needle)) return cursor;
  }
  throw new Error(`Timed out waiting for ${needle}`);
}

function normalizeTerminal(value: string): string {
  return value.replace(/\r/g, '');
}
function fdCount(): number {
  try { return readdirSync('/proc/self/fd').length; } catch { return 0; }
}
async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Unable to allocate port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); return address.port;
}
async function listen(runtime: TerminalHttpRuntime, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => { runtime.httpServer.once('error', reject); runtime.httpServer.listen(port, '127.0.0.1', resolve); });
}
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(25); }
  throw new Error('Timed out waiting for condition');
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
