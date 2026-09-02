import { afterEach, describe, expect, it } from 'vitest';
import { createTerminalHttpRuntime, pruneRateLimitBuckets, type RateLimitBucket } from '../../packages/mcp-server/src/http.js';
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
});
