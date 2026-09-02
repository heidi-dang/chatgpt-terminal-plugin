import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../packages/mcp-server/src/config.js';
import { createTerminalHttpRuntime } from '../../packages/mcp-server/src/http.js';

const execFileAsync = promisify(execFile);

describe('production MCP smoke client', () => {
  it('initializes a real MCP runtime and executes terminal_list_agents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-mcp-smoke-e2e-'));
    const port = await getFreePort();
    const token = 'smoke-e2e-development-token-0123456789abcdef';
    const runtime = await createTerminalHttpRuntime(loadConfig({
      NODE_ENV: 'test',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(port),
      MCP_PUBLIC_URL: `http://127.0.0.1:${port}/mcp`,
      MCP_AUTH_MODE: 'development',
      MCP_DEVELOPMENT_TOKEN: token,
      DEVELOPMENT_USER_ID: 'smoke-e2e-user',
      OAUTH_REQUIRED_SCOPES: 'terminal',
      STREAM_TOKEN_SECRET: token,
      AGENT_DEVICE_REGISTRY_PATH: join(root, 'devices.json'),
      AGENT_ENROLLMENT_TOKEN: 'smoke-enrollment-token-0123456789abcdef',
      TERMINAL_TURN_STATE_PATH: join(root, 'turns.json'),
      TERMINAL_MAX_SESSIONS_PER_USER: '4',
      TERMINAL_MAX_SESSIONS_PER_AGENT: '4',
    }));

    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        runtime.httpServer.once('error', rejectListen);
        runtime.httpServer.listen(port, '127.0.0.1', () => {
          runtime.httpServer.off('error', rejectListen);
          resolveListen();
        });
      });
      const { stdout, stderr } = await execFileAsync(process.execPath, ['scripts/mcp-smoke.mjs'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERMINAL_SMOKE_URL: `http://127.0.0.1:${port}/mcp`,
          TERMINAL_SMOKE_TOKEN: token,
        },
        timeout: 20_000,
      });
      expect(stderr).toBe('');
      expect(stdout).toContain('mcp_smoke=ok tool=terminal_list_agents agent_count=0');
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('accepts an upstream authentication barrier on the public widget MCP boundary', async () => {
    const widgetOrigin = 'https://web-sandbox.oaiusercontent.com';
    const server = createServer((req, res) => {
      if (req.url === '/terminal-ui/styles.css') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/css; charset=utf-8');
        res.setHeader('access-control-allow-origin', widgetOrigin);
        res.end('body{}');
        return;
      }
      if (req.url === '/terminal-ui/reload') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream; charset=utf-8');
        res.setHeader('access-control-allow-origin', widgetOrigin);
        res.end('event: ready\ndata: {}\n\n');
        return;
      }
      if (req.url === '/mcp') {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid_token', error_description: 'Missing or invalid access token' }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not allocate widget proxy test port.');

    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, ['scripts/mcp-smoke.mjs'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERMINAL_SMOKE_URL: `http://127.0.0.1:${address.port}/mcp`,
          TERMINAL_SMOKE_WIDGET_ORIGIN: widgetOrigin,
          TERMINAL_SMOKE_WIDGET_ONLY: '1',
        },
        timeout: 20_000,
      });
      expect(stderr).toBe('');
      expect(stdout).toContain(`widget_smoke=ok origin=${widgetOrigin}`);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    }
  }, 30_000);

  it('executes a production MCP smoke over direct loopback without public OAuth credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-mcp-local-deploy-smoke-e2e-'));
    const port = await getFreePort();
    const runtime = await createTerminalHttpRuntime(loadConfig({
      NODE_ENV: 'production',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(port),
      MCP_PUBLIC_URL: 'https://terminal.example.test/mcp',
      MCP_AUTH_MODE: 'cloudflare-access',
      OAUTH_ISSUER: 'https://example.cloudflareaccess.com',
      OAUTH_JWKS_URL: 'https://example.cloudflareaccess.com/cdn-cgi/access/certs',
      OAUTH_AUDIENCE: 'deployment-smoke-audience',
      OAUTH_REQUIRED_SCOPES: 'terminal',
      STREAM_TOKEN_SECRET: 'deployment-smoke-stream-secret-0123456789abcdef',
      AGENT_DEVICE_REGISTRY_PATH: join(root, 'devices.json'),
      AGENT_ENROLLMENT_TOKEN: 'deployment-smoke-enrollment-token-0123456789abcdef',
      TERMINAL_TURN_STATE_PATH: join(root, 'turns.json'),
      TERMINAL_MAX_SESSIONS_PER_USER: '4',
      TERMINAL_MAX_SESSIONS_PER_AGENT: '4',
    }));

    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        runtime.httpServer.once('error', rejectListen);
        runtime.httpServer.listen(port, '127.0.0.1', () => {
          runtime.httpServer.off('error', rejectListen);
          resolveListen();
        });
      });

      const { stdout, stderr } = await execFileAsync(process.execPath, ['scripts/mcp-smoke.mjs'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERMINAL_SMOKE_URL: `http://127.0.0.1:${port}/mcp`,
          TERMINAL_SMOKE_LOCAL: '1',
          TERMINAL_SMOKE_WIDGET_ORIGIN: 'https://web-sandbox.oaiusercontent.com',
        },
        timeout: 20_000,
      });
      expect(stderr).toBe('');
      expect(stdout).toContain('mcp_smoke=ok tool=terminal_list_agents agent_count=0');

      const proxied = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'x-terminal-deployment-smoke': '1',
          'x-forwarded-for': '203.0.113.10',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'proxied-smoke-rejection', version: '1.0.0' },
          },
        }),
      });
      expect(proxied.status).toBe(401);
      await expect(proxied.json()).resolves.toEqual({ error: 'cloudflare_access_assertion_required' });
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

});

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
