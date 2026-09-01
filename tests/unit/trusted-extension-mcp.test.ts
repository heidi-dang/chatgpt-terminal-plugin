import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../packages/mcp-server/src/config.js';
import { createTerminalHttpRuntime, type TerminalHttpRuntime } from '../../packages/mcp-server/src/http.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('trusted extension MCP surface', () => {
  it('does not advertise terminal_reload_agent when the admin extension root is unconfigured', async () => {
    const { client } = await startDevelopmentMcp('developer');
    const listed = await client.listTools();
    expect(listed.tools.some((tool) => tool.name === 'terminal_reload_agent')).toBe(false);
  });

  it('advertises the tool when configured but denies developer execution server-side', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-extension-mcp-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const extensions = join(root, 'extensions');
    await mkdir(extensions);
    await writeFile(join(extensions, 'diagnostics.mjs'), 'export default () => {}\n');

    const { client } = await startDevelopmentMcp('developer', extensions);
    const listed = await client.listTools();
    expect(listed.tools.some((tool) => tool.name === 'terminal_reload_agent')).toBe(true);

    const denied = await client.callTool({ name: 'terminal_reload_agent', arguments: { extension_id: 'diagnostics' } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain('PERMISSION_DENIED');
  });

  it('lets owner-full reload a trusted extension and exposes its registered tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-extension-mcp-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const extensions = join(root, 'extensions');
    await mkdir(extensions);
    await writeFile(join(extensions, 'diagnostics.mjs'), [
      'export default function register(registrar) {',
      "  registrar.registerTool('diagnostics_probe', { title: 'Diagnostics probe' }, async () => ({",
      "    content: [{ type: 'text', text: 'extension-ok' }]",
      '  }));',
      '}',
      '',
    ].join('\n'));

    const { client } = await startDevelopmentMcp('owner-full', extensions);
    const reloaded = await client.callTool({ name: 'terminal_reload_agent', arguments: { extension_id: 'diagnostics' } });
    expect(reloaded.isError).not.toBe(true);
    expect(reloaded.structuredContent).toMatchObject({
      extension_id: 'diagnostics',
      status: 'loaded',
      registration_count: 1,
    });

    const listed = await client.listTools();
    expect(listed.tools.some((tool) => tool.name === 'diagnostics_probe')).toBe(true);
    const probe = await client.callTool({ name: 'diagnostics_probe', arguments: {} });
    expect(JSON.stringify(probe)).toContain('extension-ok');
  });
});

async function startDevelopmentMcp(
  profile: 'developer' | 'owner-full',
  extensionRoot?: string,
): Promise<{ runtime: TerminalHttpRuntime; client: Client }> {
  const port = await freePort();
  const token = `trusted-extension-${profile}-token`;
  const config = loadConfig({
    NODE_ENV: 'test',
    MCP_HOST: '127.0.0.1',
    MCP_PORT: String(port),
    MCP_PUBLIC_URL: `http://127.0.0.1:${port}/mcp`,
    MCP_AUTH_MODE: 'development',
    MCP_DEVELOPMENT_TOKEN: token,
    MCP_DEFAULT_EXECUTION_PROFILE: profile,
    OAUTH_REQUIRED_SCOPES: 'terminal',
    STREAM_TOKEN_SECRET: `${token}-stream-secret-0123456789`,
    REQUESTS_PER_MINUTE: '1000',
    ...(extensionRoot ? { MCP_EXTENSION_ROOT: extensionRoot } : {}),
  });
  const runtime = await createTerminalHttpRuntime(config);
  await new Promise<void>((resolve, reject) => {
    runtime.httpServer.once('error', reject);
    runtime.httpServer.listen(port, '127.0.0.1', resolve);
  });
  cleanup.push(() => runtime.close());

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    authProvider: { token: async () => token },
  });
  const client = new Client({ name: 'trusted-extension-test', version: '1.0.0' });
  await client.connect(transport);
  cleanup.push(() => client.close());
  return { runtime, client };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate MCP port.');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
