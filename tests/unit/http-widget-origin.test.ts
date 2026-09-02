import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../packages/mcp-server/src/config.js';
import { createTerminalHttpRuntime } from '../../packages/mcp-server/src/http.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function startRuntime() {
  const config = loadConfig({
    NODE_ENV: 'test',
    MCP_HOST: '127.0.0.1',
    MCP_PORT: '8787',
    MCP_PUBLIC_URL: 'http://127.0.0.1:8787/mcp',
    MCP_AUTH_MODE: 'development',
    MCP_DEVELOPMENT_TOKEN: 'widget-origin-development-token-0123456789',
    DEVELOPMENT_USER_ID: 'widget-origin-user',
    STREAM_TOKEN_SECRET: 'widget-origin-stream-secret-0123456789abcdef',
  });
  const runtime = await createTerminalHttpRuntime(config);
  await new Promise<void>((resolve, reject) => {
    runtime.httpServer.once('error', reject);
    runtime.httpServer.listen(0, '127.0.0.1', resolve);
  });
  cleanup.push(() => runtime.close());
  const address = runtime.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate test HTTP port.');
  return `http://127.0.0.1:${address.port}`;
}

const chatGptOrigin = 'https://web-sandbox.oaiusercontent.com';

describe('ChatGPT widget origin policy', () => {
  it('allows the canonical ChatGPT sandbox to load terminal UI assets', async () => {
    const base = await startRuntime();
    const response = await fetch(`${base}/terminal-ui/styles.css`, {
      headers: { Origin: chatGptOrigin },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(chatGptOrigin);
    expect(response.headers.get('vary')).toContain('Origin');
  });

  it('allows legitimate subdomains in the ChatGPT widget sandbox family', async () => {
    const base = await startRuntime();
    const origin = 'https://session-123.web-sandbox.oaiusercontent.com';
    const response = await fetch(`${base}/terminal-ui/styles.css`, {
      headers: { Origin: origin },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  });

  it('lets the ChatGPT sandbox reach the terminal SSE handler instead of the global origin guard', async () => {
    const base = await startRuntime();
    const response = await fetch(`${base}/terminal/00000000-0000-4000-8000-000000000001/events?token=invalid`, {
      headers: { Origin: chatGptOrigin },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe(chatGptOrigin);
    expect(await response.json()).toMatchObject({ code: 'STREAM_TOKEN_EXPIRED' });
  });

  it('allows the ChatGPT sandbox to reach the terminal UI reload SSE endpoint', async () => {
    const base = await startRuntime();
    const controller = new AbortController();
    const response = await fetch(`${base}/terminal-ui/reload`, {
      headers: { Origin: chatGptOrigin },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('access-control-allow-origin')).toBe(chatGptOrigin);
    const reader = response.body?.getReader();
    const chunk = await reader?.read();
    controller.abort();
    expect(new TextDecoder().decode(chunk?.value)).toContain('data:');
  });

  it('does not widen the MCP transport to the ChatGPT widget origin', async () => {
    const base = await startRuntime();
    const response = await fetch(`${base}/mcp`, {
      headers: { Origin: chatGptOrigin },
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error?.message).toContain('Invalid Origin');
  });

  it('rejects unrelated browser origins on widget routes', async () => {
    const base = await startRuntime();
    const response = await fetch(`${base}/terminal-ui/styles.css`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
