import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../packages/mcp-server/src/config.js';
import { createTerminalHttpRuntime } from '../../packages/mcp-server/src/http.js';
import { StreamTokenService } from '../../packages/mcp-server/src/stream-token.js';
import type { SessionRecord } from '../../packages/mcp-server/src/gateway.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('HTTP shutdown lifecycle', () => {
  it('closes active terminal SSE responses instead of waiting for capability expiry', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: '8787',
      MCP_PUBLIC_URL: 'http://127.0.0.1:8787/mcp',
      MCP_AUTH_MODE: 'development',
      MCP_DEVELOPMENT_TOKEN: 'http-shutdown-development-token-0123456789',
      DEVELOPMENT_USER_ID: 'user-shutdown',
      STREAM_TOKEN_SECRET: 'http-shutdown-stream-secret-0123456789abcdef',
      STREAM_TOKEN_TTL_SECONDS: '120',
    });
    const runtime = await createTerminalHttpRuntime(config);
    await new Promise<void>((resolve, reject) => {
      runtime.httpServer.once('error', reject);
      runtime.httpServer.listen(0, '127.0.0.1', resolve);
    });

    let runtimeClosed = false;
    cleanup.push(async () => {
      if (!runtimeClosed) await runtime.close();
    });

    const address = runtime.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Unable to allocate HTTP port.');
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const now = new Date().toISOString();
    const sessions = (runtime.gateway as unknown as { sessions: Map<string, SessionRecord> }).sessions;
    sessions.set(sessionId, {
      ownerId: 'user-shutdown',
      agentId: 'agent-shutdown',
      session: {
        session_id: sessionId,
        agent_id: 'agent-shutdown',
        user_id: 'user-shutdown',
        execution_profile: 'developer',
        cwd: '/tmp',
        shell: 'bash',
        cols: 80,
        rows: 24,
        status: 'running',
        created_at: now,
        last_activity_at: now,
        exit_code: null,
      },
      events: [],
      eventSizes: [],
      eventHead: 0,
      latestSequence: 0,
      earliestSequence: 1,
      retainedBytes: 0,
      totalEvents: 0,
      totalOutputBytes: 0,
      commandCount: 0,
    });

    const token = new StreamTokenService(config.streamTokenSecret, config.streamTokenTtlSeconds)
      .issue('user-shutdown', sessionId).token;
    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/terminal/${sessionId}/events?after=0&token=${encodeURIComponent(token)}`,
      { signal: controller.signal },
    );
    expect(response.status).toBe(200);

    const closePromise = runtime.close().then(() => {
      runtimeClosed = true;
      return 'closed' as const;
    });
    const outcome = await Promise.race([
      closePromise,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 150)),
    ]);

    controller.abort();
    if (outcome === 'timeout') await closePromise;
    expect(outcome).toBe('closed');
  });
});
