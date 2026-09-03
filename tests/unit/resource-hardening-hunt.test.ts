import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeBlockExecutor } from '../../packages/local-agent/src/code-block-executor.js';
import { AgentGatewayClient } from '../../packages/local-agent/src/gateway-client.js';
import { cleanEnvironment, LocalTerminalAgent, WorkspacePolicy } from '../../packages/local-agent/src/index.js';
import { loadConfig } from '../../packages/mcp-server/src/config.js';
import { createTerminalHttpRuntime } from '../../packages/mcp-server/src/http.js';
import { StreamTokenService } from '../../packages/mcp-server/src/stream-token.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

function testConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    MCP_HOST: '127.0.0.1',
    MCP_PORT: '8787',
    MCP_PUBLIC_URL: 'http://127.0.0.1:8787/mcp',
    MCP_AUTH_MODE: 'development',
    MCP_DEVELOPMENT_TOKEN: 'resource-hardening-token-0123456789',
    DEVELOPMENT_USER_ID: 'resource-hardening-user',
    STREAM_TOKEN_SECRET: 'resource-hardening-stream-secret-0123456789abcdef',
    AGENT_ENROLLMENT_TOKEN: 'resource-hardening-enrollment-token',
    REQUESTS_PER_MINUTE: '1000',
    ...overrides,
  });
}

async function startRuntime(overrides: NodeJS.ProcessEnv = {}) {
  const config = testConfig(overrides);
  const runtime = await createTerminalHttpRuntime(config);
  await new Promise<void>((resolve, reject) => {
    runtime.httpServer.once('error', reject);
    runtime.httpServer.listen(0, '127.0.0.1', resolve);
  });
  cleanup.push(() => runtime.close());
  const address = runtime.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate HTTP test port.');
  return { config, runtime, base: `http://127.0.0.1:${address.port}` };
}

async function initializeMcp(base: string, token = 'resource-hardening-token-0123456789') {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: randomUUID(), method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'resource-hardening', version: '1.0.0' } },
    }),
  });
}

describe('resource hardening hunt', () => {
  it('bounds resident MCP transport sessions before the idle sweeper runs', async () => {
    const { base } = await startRuntime({ MCP_MAX_SESSIONS: '2', MCP_SESSION_IDLE_MS: '60000' });
    const first = await initializeMcp(base);
    const second = await initializeMcp(base);
    const third = await initializeMcp(base);
    await Promise.all([first.text(), second.text(), third.text()]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(503);
  });

  it('bounds unauthenticated UI reload SSE fan-out', async () => {
    const { base } = await startRuntime({ MCP_MAX_UI_RELOAD_CLIENTS: '2' });
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    cleanup.push(() => controllers.forEach((controller) => controller.abort()));
    const first = await fetch(`${base}/terminal-ui/reload`, { signal: controllers[0]!.signal });
    const second = await fetch(`${base}/terminal-ui/reload`, { signal: controllers[1]!.signal });
    const third = await fetch(`${base}/terminal-ui/reload`, { signal: controllers[2]!.signal });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(503);
  });

  it('bounds terminal SSE fan-out for one capability/session', async () => {
    const { config, runtime, base } = await startRuntime({ MCP_MAX_TERMINAL_STREAMS_PER_SESSION: '2' });
    const sessionId = '00000000-0000-4000-8000-000000000111';
    const now = new Date().toISOString();
    const sessions = (runtime.gateway as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set(sessionId, {
      ownerId: 'resource-hardening-user',
      agentId: 'agent-stream-cap',
      session: {
        session_id: sessionId, agent_id: 'agent-stream-cap', user_id: 'resource-hardening-user', execution_profile: 'developer',
        cwd: '/tmp', shell: 'bash', cols: 80, rows: 24, status: 'running', created_at: now, last_activity_at: now, exit_code: null,
      },
      events: [], eventSizes: [], eventHead: 0, latestSequence: 0, earliestSequence: 1,
      retainedBytes: 0, totalEvents: 0, totalOutputBytes: 0, commandCount: 0,
    });
    const token = new StreamTokenService(config.streamTokenSecret, config.streamTokenTtlSeconds)
      .issue('resource-hardening-user', sessionId).token;
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    cleanup.push(() => controllers.forEach((controller) => controller.abort()));
    const url = `${base}/terminal/${sessionId}/events?after=0&token=${encodeURIComponent(token)}`;
    const first = await fetch(url, { signal: controllers[0]!.signal });
    const second = await fetch(url, { signal: controllers[1]!.signal });
    const third = await fetch(url, { signal: controllers[2]!.signal });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it('bounds rate-limit bucket cardinality within one minute', async () => {
    const { config, base } = await startRuntime({ RATE_LIMIT_MAX_BUCKETS: '2' });
    const statuses: number[] = [];
    for (const address of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      const response = await fetch(`${base}${config.agentEnrollmentPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': address },
        body: '{}',
      });
      statuses.push(response.status);
      await response.text();
    }
    expect(statuses).toEqual([400, 400, 429]);
  });

  it('releases journal file handles when a retained terminal session is evicted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-journal-release-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const agent = new LocalTerminalAgent({
      agentId: 'agent-journal-release', allowedWorkspaceRoots: [root], executionProfile: 'developer', shells: ['bash'],
      eventJournalDir: join(root, '.journal'), eventJournalMaxBytes: 64 * 1024, eventJournalRetentionMs: 60_000,
      closedSessionRetentionMs: 20, sweepIntervalMs: 5,
    });
    cleanup.push(() => agent.shutdown());
    const started = agent.start('user-a', {
      agent_id: 'agent-journal-release', cwd: root, shell: 'bash', cols: 80, rows: 24,
    }, 'developer');
    agent.close(started.session.session_id);
    await waitUntil(() => {
      try { agent.status(started.session.session_id); return false; } catch { return true; }
    });
    const writers = ((agent as unknown as { eventJournal?: { writers: Map<string, unknown> } }).eventJournal)?.writers;
    expect(writers?.has(started.session.session_id)).toBe(false);
  });

  it('drops gateway replay cursors for sessions absent from an authoritative resume snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-replay-prune-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const agent = new LocalTerminalAgent({
      agentId: 'agent-replay-prune', allowedWorkspaceRoots: [root], executionProfile: 'owner-full', shells: ['bash'],
    });
    cleanup.push(() => agent.shutdown());
    const client = new AgentGatewayClient(agent, {
      url: 'ws://127.0.0.1/', identity: {} as never, heartbeatMs: 1000, reconnectMaxMs: 1000, outboundHighWaterBytes: 1024 * 1024,
    });
    const internal = client as unknown as {
      ackedSequence: Map<string, number>; sentSequence: Map<string, number>; handleMessage(raw: string): void;
    };
    internal.ackedSequence.set('stale-session', 12);
    internal.sentSequence.set('stale-session', 15);
    internal.handleMessage(JSON.stringify({ type: 'agent.resume.ack', sequences: {} }));
    expect(internal.ackedSequence.has('stale-session')).toBe(false);
    expect(internal.sentSequence.has('stale-session')).toBe(false);
  });

  it('refuses a 257th workspace root so persisted state remains restart-readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-workspace-root-cap-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const directories = Array.from({ length: 257 }, (_, index) => join(root, `root-${index}`));
    await Promise.all(directories.map((directory) => mkdir(directory)));
    const policy = new WorkspacePolicy([], 'developer');
    for (const directory of directories.slice(0, 256)) policy.addRoot(directory);
    expect(policy.getRoots()).toHaveLength(256);
    expect(() => policy.addRoot(directories[256]!)).toThrow(/workspace root limit/i);
    expect(policy.getRoots()).toHaveLength(256);
  });

  it('bounds concurrent code executions before spawning excess child processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-code-concurrency-cap-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executor = new CodeBlockExecutor({ environment: cleanEnvironment(), maxConcurrentExecutions: 1 } as never);
    cleanup.push(() => executor.shutdown());
    const first = executor.execute('user-a', {
      execution_id: randomUUID(), runtime: 'node', code: 'setTimeout(() => {}, 150)', timeout_ms: 1000,
    }, root);
    await waitUntil(() => executor.activeCount === 1);
    const second = executor.execute('user-a', {
      execution_id: randomUUID(), runtime: 'node', code: 'console.log("second")', timeout_ms: 1000,
    }, root);
    const [, secondResult] = await Promise.allSettled([first, second]);
    expect(secondResult.status).toBe('rejected');
    if (secondResult.status === 'rejected') expect(secondResult.reason).toMatchObject({ code: 'SESSION_LIMIT_REACHED' });
  });
});

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition.');
}
