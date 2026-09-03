import { afterEach, describe, expect, it } from 'vitest';
import { createTerminalHttpRuntime, pruneRateLimitBuckets, writeTerminalSseEvents, type RateLimitBucket } from '../../packages/mcp-server/src/http.js';
import { loadConfig } from '../../packages/mcp-server/src/config.js';


const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('HTTP JSON ingress bounds', () => {
  it('allows protocol-sized JSON-RPC envelopes while retaining a bounded parser ceiling', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: '8787',
      MCP_PUBLIC_URL: 'http://127.0.0.1:8787/mcp',
      MCP_AUTH_MODE: 'development',
      MCP_DEVELOPMENT_TOKEN: 'http-memory-development-token-0123456789',
      DEVELOPMENT_USER_ID: 'user-memory',
      STREAM_TOKEN_SECRET: 'http-memory-stream-secret-0123456789abcdef',
      AGENT_ENROLLMENT_TOKEN: 'http-memory-enrollment-token',
      REQUESTS_PER_MINUTE: '1000',
    });
    const runtime = await createTerminalHttpRuntime(config);
    await new Promise<void>((resolve, reject) => {
      runtime.httpServer.once('error', reject);
      runtime.httpServer.listen(0, '127.0.0.1', resolve);
    });
    cleanup.push(() => runtime.close());
    const address = runtime.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Unable to allocate HTTP ingress test port.');
    const endpoint = `http://127.0.0.1:${address.port}${config.agentEnrollmentPath}`;

    const protocolSized = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(300 * 1024) }),
    });
    expect(protocolSized.status).toBe(400);
    expect(await protocolSized.json()).toEqual({ error: 'invalid_device_enrollment' });

    const oversized = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(600 * 1024) }),
    });
    expect(oversized.status).toBe(413);
  });
});

describe('HTTP MCP session retention', () => {
  it('expires abandoned MCP transport sessions after the configured idle window', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: '8787',
      MCP_PUBLIC_URL: 'http://127.0.0.1:8787/mcp',
      MCP_AUTH_MODE: 'development',
      MCP_DEVELOPMENT_TOKEN: 'http-session-retention-token-0123456789',
      DEVELOPMENT_USER_ID: 'user-session-retention',
      STREAM_TOKEN_SECRET: 'http-session-retention-secret-0123456789abcdef',
      AGENT_ENROLLMENT_TOKEN: 'http-session-retention-enrollment-token',
      MCP_SESSION_IDLE_MS: '500',
      MCP_SESSION_SWEEP_INTERVAL_MS: '20',
    });
    const runtime = await createTerminalHttpRuntime(config);
    await new Promise<void>((resolve, reject) => {
      runtime.httpServer.once('error', reject);
      runtime.httpServer.listen(0, '127.0.0.1', resolve);
    });
    cleanup.push(() => runtime.close());
    const address = runtime.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Unable to allocate MCP retention test port.');
    const base = `http://127.0.0.1:${address.port}`;

    const initialized = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer http-session-retention-token-0123456789',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'retention-test', version: '1.0.0' } },
      }),
    });
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get('mcp-session-id')).toBeTruthy();
    await initialized.text();

    const initialHealth = await (await fetch(`${base}/health`)).json() as { mcp_sessions?: number };
    expect(initialHealth.mcp_sessions).toBe(1);

    const deadline = Date.now() + 3_000;
    let remaining = initialHealth.mcp_sessions;
    while (Date.now() < deadline && remaining !== 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const health = await (await fetch(`${base}/health`)).json() as { mcp_sessions?: number };
      remaining = health.mcp_sessions;
    }
    expect(remaining).toBe(0);
  });
});

describe('HTTP bounded-memory helpers', () => {
  it('prunes rate-limit buckets from previous minutes while preserving the current minute', () => {
    const buckets = new Map<string, RateLimitBucket>([
      ['old-a', { minute: 100, count: 1 }],
      ['old-b', { minute: 101, count: 4 }],
      ['current-a', { minute: 102, count: 2 }],
      ['future-defensive', { minute: 103, count: 1 }],
    ]);

    pruneRateLimitBuckets(buckets, 102);

    expect([...buckets.keys()]).toEqual(['current-a', 'future-defensive']);
  });

  it('stops SSE writes at Node backpressure and resumes from the exact next sequence', () => {
    const now = new Date().toISOString();
    const events = [5, 6, 7].map((sequence) => ({
      event_id: `event-${sequence}`,
      session_id: 'session-stream',
      sequence,
      timestamp: now,
      actor: 'agent' as const,
      event_type: 'terminal.stdout' as const,
      data: { text: `line-${sequence}\n` },
    }));
    const firstFrames: string[] = [];
    const first = writeTerminalSseEvents(events, 4, (frame) => {
      firstFrames.push(frame);
      return firstFrames.length < 2;
    });

    expect(first).toEqual({ lastSequence: 6, backpressured: true });
    expect(firstFrames).toHaveLength(2);
    expect(firstFrames[0]).toContain('id: 5');
    expect(firstFrames[1]).toContain('id: 6');

    const resumedFrames: string[] = [];
    const resumed = writeTerminalSseEvents(events, first.lastSequence, (frame) => {
      resumedFrames.push(frame);
      return true;
    });
    expect(resumed).toEqual({ lastSequence: 7, backpressured: false });
    expect(resumedFrames).toHaveLength(1);
    expect(resumedFrames[0]).toContain('id: 7');
  });
});
