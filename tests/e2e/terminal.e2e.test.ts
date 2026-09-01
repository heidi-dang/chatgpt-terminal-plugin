import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalTerminalAgent } from '../../packages/local-agent/src/index.js';
import { AgentGatewayClient } from '../../packages/local-agent/src/gateway-client.js';
import { DeviceIdentity, enrollDevice } from '../../packages/local-agent/src/device-identity.js';
import { loadConfig } from '../../packages/mcp-server/src/config.js';
import { createTerminalHttpRuntime, type TerminalHttpRuntime } from '../../packages/mcp-server/src/http.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('terminal MCP end-to-end', () => {
  it('runs a persistent signed local PTY through the actual MCP v2 client', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-e2e-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);

    const port = await getFreePort();
    const publicUrl = `http://127.0.0.1:${port}/mcp`;
    const baseUrl = `http://127.0.0.1:${port}`;
    const developmentToken = 'e2e-development-token-0123456789abcdef';
    const enrollmentToken = 'e2e-enrollment-token-0123456789abcdef';
    const ownerId = 'user-e2e';
    const transcriptPath = join(root, 'transcript.jsonl');
    const auditPath = join(root, 'audit.jsonl');

    const config = loadConfig({
      NODE_ENV: 'test',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(port),
      MCP_PUBLIC_URL: publicUrl,
      MCP_AUTH_MODE: 'development',
      MCP_DEVELOPMENT_TOKEN: developmentToken,
      DEVELOPMENT_USER_ID: ownerId,
      OAUTH_REQUIRED_SCOPES: 'terminal',
      STREAM_TOKEN_SECRET: developmentToken,
      AGENT_GATEWAY_PATH: '/agent',
      AGENT_ENROLLMENT_PATH: '/agent/enroll',
      AGENT_DEVICE_REGISTRY_PATH: join(root, 'devices.json'),
      AGENT_ENROLLMENT_TOKEN: enrollmentToken,
      AGENT_AUTH_CHALLENGE_TTL_MS: '5000',
      TERMINAL_MAX_READ_BYTES: '32768',
      TERMINAL_MAX_EVENT_BYTES: '65536',
      TERMINAL_BUFFER_HIGH_WATER_BYTES: String(1024 * 1024),
      TERMINAL_MAX_SESSIONS_PER_USER: '4',
      TERMINAL_MAX_SESSIONS_PER_AGENT: '4',
      TERMINAL_IDLE_TIMEOUT_MS: '60000',
      TERMINAL_MAX_LIFETIME_MS: '120000',
      TERMINAL_SWEEP_INTERVAL_MS: '1000',
      AGENT_REQUEST_TIMEOUT_MS: '5000',
      // Deliberately tiny: enrollment may use the source limiter once, while the
      // authenticated MCP transport must remain unthrottled for the full workflow.
      REQUESTS_PER_MINUTE: '1',
      AUDIT_LOG_PATH: auditPath,
      TRANSCRIPT_LOG_PATH: transcriptPath,
      TRANSCRIPT_RETENTION_DAYS: '7',
    });

    const runtime = await createTerminalHttpRuntime(config);
    await listen(runtime, port);
    cleanup.push(() => runtime.close());

    const identity = await DeviceIdentity.loadOrCreate(join(root, 'device.json'));
    const enrollmentStatus = await enrollDevice({
      identity,
      enrollmentUrl: `${baseUrl}/agent/enroll`,
      enrollmentToken,
      ownerId,
      displayName: 'E2E computer',
    });
    expect(enrollmentStatus).toBe('enrolled');

    const agent = new LocalTerminalAgent({
      agentId: identity.agentId,
      displayName: 'E2E computer',
      allowedWorkspaceRoots: [workspace],
      executionProfile: 'owner-full',
      shells: ['bash'],
      bufferHighWaterBytes: 1024 * 1024,
      maxEventBytes: 64 * 1024,
      idleTimeoutMs: 60_000,
      maxLifetimeMs: 120_000,
      sweepIntervalMs: 1000,
    });
    const gatewayClient = new AgentGatewayClient(agent, {
      url: `ws://127.0.0.1:${port}/agent`,
      identity,
      heartbeatMs: 500,
      reconnectMaxMs: 1000,
      outboundHighWaterBytes: 1024 * 1024,
      maxInflightEvents: 16,
    });
    const gatewayRun = gatewayClient.start();
    cleanup.push(async () => {
      gatewayClient.stop();
      await Promise.race([gatewayRun, delay(2000)]);
    });
    await waitUntil(() => runtime.gateway.listAgents(ownerId).some((candidate) => candidate.agent_id === identity.agentId && candidate.online));

    const client = new Client({ name: 'terminal-e2e-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      authProvider: { token: async () => developmentToken },
    });
    await client.connect(transport);
    cleanup.push(() => client.close());

    const listed = await client.listTools();
    const toolNames = new Set(listed.tools.map((tool) => tool.name));
    for (const expected of [
      'terminal_list_agents',
      'terminal_start',
      'terminal_read',
      'terminal_write',
      'terminal_interrupt',
      'terminal_status',
      'terminal_stream_refresh',
      'terminal_close',
    ]) expect(toolNames.has(expected)).toBe(true);

    const startTool = listed.tools.find((tool) => tool.name === 'terminal_start');
    const startMeta = startTool?._meta as Record<string, unknown> | undefined;
    const startUi = startMeta?.ui as Record<string, unknown> | undefined;
    expect(startUi?.resourceUri).toBe('ui://terminal/v7.html');
    expect(startMeta?.['openai/outputTemplate']).toBe('ui://terminal/v7.html');
    const refreshTool = listed.tools.find((tool) => tool.name === 'terminal_stream_refresh');
    const refreshMeta = refreshTool?._meta as Record<string, unknown> | undefined;
    const refreshUi = refreshMeta?.ui as Record<string, unknown> | undefined;
    expect(refreshUi?.visibility).toEqual(['app']);
    expect(refreshMeta?.['openai/widgetAccessible']).toBe(true);
    for (const toolName of ['terminal_read', 'terminal_status']) {
      const toolMeta = listed.tools.find((tool) => tool.name === toolName)?._meta as Record<string, unknown> | undefined;
      const toolUi = toolMeta?.ui as Record<string, unknown> | undefined;
      expect(toolUi?.visibility).toEqual(['model', 'app']);
      expect(toolMeta?.['openai/widgetAccessible']).toBe(true);
    }

    const resourceResult = await client.readResource({ uri: 'ui://terminal/v7.html' });
    const uiResource = resourceResult.contents[0] as {
      mimeType?: string;
      text?: string;
      _meta?: {
        ui?: { csp?: { connectDomains?: string[] }; permissions?: Record<string, unknown> };
        'openai/widgetCSP'?: { connect_domains?: string[]; resource_domains?: string[] };
        'openai/widgetDomain'?: string;
      };
    } | undefined;
    expect(uiResource?.mimeType).toBe('text/html;profile=mcp-app');
    expect(uiResource?.text).toContain('data-terminal-static-shell');
    expect(uiResource?.text).toContain('CHATGPT LIVE TERMINAL');
    expect(uiResource?.text).toContain('Terminal UI ready.');
    expect(uiResource?.text).not.toContain('<div id="root"></div>');
    expect(uiResource?._meta?.ui?.csp?.connectDomains).toEqual([baseUrl]);
    expect(uiResource?._meta?.['openai/widgetCSP']?.connect_domains).toEqual([baseUrl]);
    expect(uiResource?._meta?.['openai/widgetCSP']?.resource_domains).toEqual([]);
    expect(uiResource?._meta?.['openai/widgetDomain']).toBe(baseUrl);
    expect(uiResource?._meta?.ui?.permissions).toBeUndefined();
    expect(uiResource?.text).toMatch(/meta name="terminal-ui-version" content="[^"]+"/);

    const runtimeUiResponse = await fetch(`${baseUrl}/terminal-ui/runtime.html`, { cache: 'no-store' });
    expect(runtimeUiResponse.status).toBe(404);
    const reloadResponse = await fetch(`${baseUrl}/terminal-ui/reload`, { headers: { accept: 'text/event-stream' } });
    expect(reloadResponse.status).toBe(200);
    expect(reloadResponse.headers.get('content-type')).toContain('text/event-stream');
    if (!reloadResponse.body) throw new Error('UI reload SSE response has no body.');
    const reloadReader = reloadResponse.body.getReader();
    const firstReloadFrame = await readSseFrame(reloadReader, 2000);
    expect(firstReloadFrame).toContain('data: {"version":"');
    await reloadReader.cancel();

    const agentList = structured(await client.callTool({ name: 'terminal_list_agents', arguments: {} }));
    expect((agentList.agents as Array<{ agent_id: string }>).some((candidate) => candidate.agent_id === identity.agentId)).toBe(true);

    const startedResult = await client.callTool({
      name: 'terminal_start',
      arguments: { agent_id: identity.agentId, cwd: workspace, shell: 'bash', cols: 80, rows: 24 },
    });
    const started = structured(startedResult);
    const sessionId = stringField(started, 'session_id');
    let cursor = numberField(started, 'cursor');

    await client.callTool({ name: 'terminal_write', arguments: { session_id: sessionId, text: "printf '__HELLO__\\n'\r" } });
    ({ cursor } = await readUntil(client, sessionId, cursor, '__HELLO__'));

    await client.callTool({
      name: 'terminal_write',
      arguments: { session_id: sessionId, text: "mkdir -p child && cd child && printf '__CHANGED_DIR__\\n'\r" },
    });
    ({ cursor } = await readUntil(client, sessionId, cursor, '__CHANGED_DIR__'));

    await client.callTool({ name: 'terminal_write', arguments: { session_id: sessionId, text: 'pwd\r' } });
    const pwd = await readUntil(client, sessionId, cursor, `${workspace}/child`);
    cursor = pwd.cursor;
    expect(normalizeTerminal(pwd.output)).toContain(`${workspace}/child`);
    await waitUntil(async () => {
      const liveStatus = structured(await client.callTool({ name: 'terminal_status', arguments: { session_id: sessionId } }));
      return liveStatus.cwd === `${workspace}/child`;
    });

    await client.callTool({ name: 'terminal_write', arguments: { session_id: sessionId, text: 'sleep 30\r' } });
    ({ cursor } = await readUntil(client, sessionId, cursor, 'sleep 30'));
    await client.callTool({ name: 'terminal_interrupt', arguments: { session_id: sessionId } });
    await client.callTool({ name: 'terminal_write', arguments: { session_id: sessionId, text: "printf '__AFTER_INTERRUPT__\\n'\r" } });
    const interrupted = await readUntil(client, sessionId, cursor, '__AFTER_INTERRUPT__');
    cursor = interrupted.cursor;
    expect(interrupted.output).toContain('__AFTER_INTERRUPT__');

    const refreshed = await client.callTool({
      name: 'terminal_stream_refresh',
      arguments: { session_id: sessionId, after: cursor },
    });
    expect(refreshed.isError).not.toBe(true);
    expect(refreshed._meta?.terminal_stream).toBeTruthy();
    expect(structured(refreshed).expires_at).toEqual(expect.any(String));

    const streamResponse = await fetch(streamCapabilityUrl(refreshed), { headers: { accept: 'text/event-stream' } });
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');
    if (!streamResponse.body) throw new Error('SSE response has no body.');
    const streamReader = streamResponse.body.getReader();
    await client.callTool({ name: 'terminal_write', arguments: { session_id: sessionId, text: "printf '__SSE_STREAM__\\n'\r" } });
    const streamedEvent = await readSseUntilStdout(streamReader, '__SSE_STREAM__', 5000);
    expect(streamedEvent.sequence).toBeGreaterThan(cursor);
    cursor = streamedEvent.sequence;
    await streamReader.cancel();

    const closed = structured(await client.callTool({ name: 'terminal_close', arguments: { session_id: sessionId } }));
    expect(closed.status).toBe('closing');
    await waitUntil(async () => {
      const finalStatus = structured(await client.callTool({ name: 'terminal_status', arguments: { session_id: sessionId } }));
      return finalStatus.status === 'closed';
    });
    const status = structured(await client.callTool({ name: 'terminal_status', arguments: { session_id: sessionId } }));
    expect(status.status).toBe('closed');
    expect(status.execution_profile).toBe('developer');
    expect(status.cwd).toBe(`${workspace}/child`);
    const finalRead = structured(await client.callTool({
      name: 'terminal_read', arguments: { session_id: sessionId, after: cursor, max_bytes: 262144, wait_ms: 0 },
    }));
    const finalEvents = finalRead.events as Array<{ event_type?: string }>;
    expect(finalEvents.at(-1)?.event_type).toBe('session.closed');

    await waitUntil(async () => {
      try {
        return (await readFile(transcriptPath, 'utf8')).includes('terminal.stdout');
      } catch {
        return false;
      }
    });
    const transcript = await readFile(transcriptPath, 'utf8');
    expect(transcript).toContain('terminal.stdout');
    expect(transcript).toContain('command.input');
    expect(transcript).toContain(sessionId);
  }, 25_000);
});

async function readUntil(
  client: Client,
  sessionId: string,
  after: number,
  needle: string,
  timeoutMs = 5000,
): Promise<{ cursor: number; output: string }> {
  const deadline = Date.now() + timeoutMs;
  let cursor = after;
  let output = '';
  while (Date.now() < deadline) {
    const result = structured(await client.callTool({
      name: 'terminal_read',
      arguments: { session_id: sessionId, after: cursor, max_bytes: 32768, wait_ms: 500 },
    }));
    cursor = numberField(result, 'next_cursor');
    output += String(result.output ?? '');
    if (normalizeTerminal(output).includes(needle)) return { cursor, output };
  }
  throw new Error(`Timed out waiting for ${needle}. Output: ${normalizeTerminal(output)}`);
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

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== 'number') throw new Error(`${key} is not a number.`);
  return field;
}

function streamCapabilityUrl(result: CallToolResult): string {
  const terminalStream = result._meta && typeof result._meta === 'object'
    ? (result._meta as Record<string, unknown>).terminal_stream
    : undefined;
  if (!terminalStream || typeof terminalStream !== 'object') throw new Error('MCP result has no terminal stream capability.');
  const url = (terminalStream as Record<string, unknown>).url;
  if (typeof url !== 'string') throw new Error('Terminal stream capability has no URL.');
  return url;
}

async function readSseFrame(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for SSE frame.')), remaining)),
    ]);
    if (result.done) throw new Error('SSE stream ended before a frame arrived.');
    buffer += decoder.decode(result.value, { stream: true });
    const frameEnd = buffer.indexOf('\n\n');
    if (frameEnd >= 0) return buffer.slice(0, frameEnd);
  }
  throw new Error('Timed out waiting for SSE frame.');
}

async function readSseUntilStdout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs: number,
): Promise<{ sequence: number; event_type: string; data: Record<string, unknown> }> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for SSE stdout: ${needle}`)), remaining)),
    ]);
    if (result.done) throw new Error(`SSE stream ended before stdout contained ${needle}.`);
    buffer += decoder.decode(result.value, { stream: true });
    let frameEnd = buffer.indexOf('\n\n');
    while (frameEnd >= 0) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data) {
        const event = JSON.parse(data) as { sequence?: unknown; event_type?: unknown; data?: unknown };
        if (
          typeof event.sequence === 'number'
          && event.event_type === 'terminal.stdout'
          && event.data && typeof event.data === 'object'
          && typeof (event.data as Record<string, unknown>).text === 'string'
          && String((event.data as Record<string, unknown>).text).includes(needle)
        ) {
          return { sequence: event.sequence, event_type: event.event_type, data: event.data as Record<string, unknown> };
        }
      }
      frameEnd = buffer.indexOf('\n\n');
    }
  }
  throw new Error(`Timed out waiting for SSE stdout: ${needle}`);
}

function normalizeTerminal(value: string): string {
  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
  return value.replace(ansiEscape, '').replace(/\r/g, '');
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate an E2E port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function listen(runtime: TerminalHttpRuntime, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    runtime.httpServer.once('error', reject);
    runtime.httpServer.listen(port, '127.0.0.1', resolve);
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for E2E condition.');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
