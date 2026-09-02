#!/usr/bin/env node
/* global URL, AbortController, TextDecoder, setTimeout, clearTimeout */

const url = process.env.TERMINAL_SMOKE_URL;
const token = process.env.TERMINAL_SMOKE_TOKEN;
const accessClientId = process.env.TERMINAL_SMOKE_CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.TERMINAL_SMOKE_CF_ACCESS_CLIENT_SECRET;
const localDeploymentSmoke = process.env.TERMINAL_SMOKE_LOCAL === '1';
const widgetOrigin = process.env.TERMINAL_SMOKE_WIDGET_ORIGIN;
const widgetOnly = process.env.TERMINAL_SMOKE_WIDGET_ONLY === '1';
const requireAgent = process.env.TERMINAL_SMOKE_REQUIRE_AGENT === '1';

if (!url) {
  console.error('TERMINAL_SMOKE_URL is required.');
  process.exit(64);
}
if ((accessClientId && !accessClientSecret) || (!accessClientId && accessClientSecret)) {
  console.error('Cloudflare Access smoke credentials must be supplied as a complete client ID/secret pair.');
  process.exit(64);
}
if (widgetOrigin) await verifyWidgetBoundary();
if (widgetOnly) {
  console.log(`widget_smoke=ok origin=${widgetOrigin ?? 'none'}`);
  process.exit(0);
}
if (!localDeploymentSmoke && !token && !(accessClientId && accessClientSecret)) {
  console.error('Authenticated MCP smoke requires a bearer token or Cloudflare Access service credentials.');
  process.exit(64);
}

const baseHeaders = {
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...(accessClientId && accessClientSecret ? {
    'cf-access-client-id': accessClientId,
    'cf-access-client-secret': accessClientSecret,
  } : {}),
  ...(localDeploymentSmoke ? { 'x-terminal-deployment-smoke': '1' } : {}),
};

const initialize = await post({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'terminal-production-smoke', version: '1.0.0' },
  },
});
const sessionId = initialize.response.headers.get('mcp-session-id');
if (!sessionId) throw new Error('MCP initialize response did not return mcp-session-id.');
const protocolVersion = stringField(initialize.message?.result, 'protocolVersion') ?? '2025-06-18';
await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId, protocolVersion, false);

const agentsResult = await callTool('terminal_list_agents', {}, sessionId, protocolVersion, 2);
const agents = agentsResult.structuredContent?.agents;
if (!Array.isArray(agents)) throw new Error('terminal_list_agents did not return structured agents data.');

if (!requireAgent) {
  console.log(`mcp_smoke=ok tool=terminal_list_agents agent_count=${agents.length}`);
  process.exit(0);
}

const agent = agents.find((candidate) => candidate?.online === true && candidate?.execution_profile !== 'read-only');
if (!agent?.agent_id) throw new Error('Production terminal smoke requires at least one online non-read-only agent for the smoke principal.');
const shell = Array.isArray(agent.capabilities?.shells) && agent.capabilities.shells.includes('bash')
  ? 'bash'
  : agent.capabilities?.shells?.[0];

let surfaceId;
try {
  const surface = await callTool('terminal_surface', {}, sessionId, protocolVersion, 3);
  surfaceId = stringField(surface.structuredContent, 'surface_id');
  if (!surfaceId) throw new Error('terminal_surface did not return surface_id.');

  const started = await callTool('terminal_start', {
    agent_id: agent.agent_id,
    surface_id: surfaceId,
    ...(shell ? { shell } : {}),
  }, sessionId, protocolVersion, 4);
  const terminalSessionId = stringField(started.structuredContent, 'session_id');
  const streamUrl = started._meta?.terminal_stream?.url;
  if (!terminalSessionId || typeof streamUrl !== 'string') throw new Error('terminal_start did not return a terminal stream capability.');

  const marker = '__TERMINAL_PRODUCTION_STREAM_SMOKE__';
  await callTool('terminal_write', { session_id: terminalSessionId, text: `printf '${marker}\\n'\r` }, sessionId, protocolVersion, 5);
  await readUntil(terminalSessionId, Number(started.structuredContent?.cursor ?? 0), marker, sessionId, protocolVersion);
  if (!widgetOrigin) throw new Error('TERMINAL_SMOKE_WIDGET_ORIGIN is required when TERMINAL_SMOKE_REQUIRE_AGENT=1.');
  const frame = await fetchFirstSseFrame(streamUrl, { Origin: widgetOrigin });
  if (!frame.includes('data:')) throw new Error(`Terminal SSE did not emit a data frame: ${frame.slice(0, 300)}`);

  console.log(`mcp_smoke=ok tool=terminal_start agent=${agent.agent_id} widget_origin=${widgetOrigin} terminal_sse=verified`);
} finally {
  if (surfaceId) await callTool('terminal_turn_close', { surface_id: surfaceId }, sessionId, protocolVersion, 90).catch(() => undefined);
}

async function callTool(name, args, sessionId, protocolVersion, id) {
  const call = await post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, sessionId, protocolVersion);
  const result = call.message?.result;
  if (!result || typeof result !== 'object') throw new Error(`${name} returned no MCP result.`);
  if (result.isError === true) throw new Error(`${name} failed: ${resultText(result)}`);
  return result;
}

async function readUntil(terminalSessionId, after, marker, sessionId, protocolVersion) {
  const deadline = Date.now() + 8_000;
  let cursor = after;
  let output = '';
  let requestId = 20;
  while (Date.now() < deadline) {
    const result = await callTool('terminal_read', {
      session_id: terminalSessionId, after: cursor, max_bytes: 32768, wait_ms: 500,
    }, sessionId, protocolVersion, requestId++);
    cursor = Number(result.structuredContent?.next_cursor ?? cursor);
    output += String(result.structuredContent?.output ?? '');
    if (output.includes(marker)) return;
  }
  throw new Error(`terminal_read did not observe ${marker}.`);
}

async function verifyWidgetBoundary() {
  if (!widgetOrigin) throw new Error('TERMINAL_SMOKE_WIDGET_ORIGIN is required for widget smoke.');
  const publicOrigin = new URL(url).origin;
  const styles = await fetch(`${publicOrigin}/terminal-ui/styles.css`, { headers: { Origin: widgetOrigin }, signal: AbortSignal.timeout(8_000) });
  if (!styles.ok) throw new Error(`Widget stylesheet smoke failed: HTTP ${styles.status} ${(await styles.text()).slice(0, 300)}`);
  if (styles.headers.get('access-control-allow-origin') !== widgetOrigin) throw new Error('Widget stylesheet CORS did not echo the ChatGPT sandbox origin.');
  await fetchFirstSseFrame(`${publicOrigin}/terminal-ui/reload`, { Origin: widgetOrigin });

  const strictMcp = await fetch(url, { headers: { Origin: widgetOrigin, accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
  const strictBody = await strictMcp.text();
  if (strictMcp.status !== 403 || !strictBody.includes('Invalid Origin')) {
    throw new Error(`MCP origin boundary was widened unexpectedly: HTTP ${strictMcp.status} ${strictBody.slice(0, 300)}`);
  }
}

async function fetchFirstSseFrame(streamUrl, requestHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(streamUrl, { headers: { accept: 'text/event-stream', ...requestHeaders }, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 300)}`);
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) throw new Error('SSE response is not text/event-stream.');
    if (requestHeaders.Origin && response.headers.get('access-control-allow-origin') !== requestHeaders.Origin) throw new Error('SSE CORS origin mismatch.');
    const reader = response.body.getReader();
    let text = '';
    const decoder = new TextDecoder();
    while (!text.match(/\r?\n\r?\n/) && text.length < 64_000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    if (!text.trim()) throw new Error('SSE stream did not emit an initial frame.');
    return text;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function post(body, sessionId, protocolVersion, expectResponse = true) {
  const headers = { ...baseHeaders };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`MCP smoke HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  if (!expectResponse || response.status === 202 || response.status === 204) {
    await response.body?.cancel();
    return { response, message: undefined };
  }
  return { response, message: await parseMessage(response) };
}

async function parseMessage(response) {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (contentType.includes('application/json')) return JSON.parse(text);
  if (contentType.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (!data) continue;
      const message = JSON.parse(data);
      if (message && typeof message === 'object' && ('result' in message || 'error' in message)) return message;
    }
  }
  throw new Error(`Unsupported MCP response content-type: ${contentType}`);
}

function stringField(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  return typeof value[key] === 'string' ? value[key] : undefined;
}

function resultText(result) {
  if (!Array.isArray(result.content)) return 'unknown tool error';
  return result.content.map((item) => item && typeof item === 'object' && item.type === 'text' ? item.text : '').filter(Boolean).join('\n');
}
