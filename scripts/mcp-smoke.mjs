#!/usr/bin/env node
/* global process, console, fetch, setTimeout, clearTimeout, URL, AbortController, TextDecoder */
const url = process.env.MCP_SMOKE_URL;
const headerName = process.env.MCP_SMOKE_HEADER_NAME;
const token = process.env.MCP_SMOKE_TOKEN;
const widgetOrigin = process.env.MCP_SMOKE_WIDGET_ORIGIN || 'https://web-sandbox.oaiusercontent.com';
if (!url || !headerName || !token) {
  console.error('MCP_SMOKE_URL, MCP_SMOKE_HEADER_NAME, and MCP_SMOKE_TOKEN are required');
  process.exit(64);
}

const publicOrigin = new URL(url).origin;
const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  [headerName]: token,
};

async function rpc(body, sessionId) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
  const payload = parsePayload(text, response.headers.get('content-type') ?? '');
  if (payload.error) throw new Error(`MCP error: ${JSON.stringify(payload.error)}`);
  return { payload, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}

async function callTool(name, args, sessionId, id) {
  const response = await rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, sessionId);
  const result = response.payload?.result;
  if (!result || result.isError) throw new Error(`${name} smoke failed: ${JSON.stringify(result)}`);
  return result;
}

function parsePayload(text, contentType) {
  if (contentType.includes('text/event-stream')) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean).at(-1);
    if (!data) throw new Error('MCP SSE response did not contain a data frame');
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

async function fetchFirstSseFrame(streamUrl, requestHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(streamUrl, {
      headers: { Accept: 'text/event-stream', ...requestHeaders },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      throw new Error(`SSE HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      throw new Error(`SSE content-type is not text/event-stream: ${response.headers.get('content-type')}`);
    }
    if (requestHeaders.Origin && response.headers.get('access-control-allow-origin') !== requestHeaders.Origin) {
      throw new Error(`SSE CORS mismatch: ${response.headers.get('access-control-allow-origin') ?? 'missing'}`);
    }
    const reader = response.body.getReader();
    let text = '';
    while (!text.includes('\n\n') && text.length < 64_000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value, { stream: true });
    }
    if (!text.trim()) throw new Error('SSE stream did not emit an initial frame');
    return text;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function verifyWidgetBoundary() {
  const styles = await fetch(`${publicOrigin}/terminal-ui/styles.css`, { headers: { Origin: widgetOrigin } });
  if (!styles.ok) throw new Error(`widget stylesheet origin smoke failed: HTTP ${styles.status} ${await styles.text()}`);
  if (styles.headers.get('access-control-allow-origin') !== widgetOrigin) {
    throw new Error('widget stylesheet did not echo the ChatGPT sandbox origin');
  }

  await fetchFirstSseFrame(`${publicOrigin}/terminal-ui/reload`, { Origin: widgetOrigin });

  const strictMcp = await fetch(url, { headers: { [headerName]: token, Origin: widgetOrigin, Accept: 'application/json' } });
  const strictBody = await strictMcp.text();
  if (strictMcp.status !== 403 || !strictBody.includes('Invalid Origin')) {
    throw new Error(`MCP browser-origin boundary was widened unexpectedly: HTTP ${strictMcp.status} ${strictBody.slice(0, 300)}`);
  }
}

await verifyWidgetBoundary();

const initialized = await rpc({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'terminal-deploy-smoke', version: '1.0.0' } },
});
if (!initialized.sessionId) throw new Error('MCP initialize did not return mcp-session-id');
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, initialized.sessionId);

const agentsResult = await callTool('terminal_list_agents', {}, initialized.sessionId, 2);
const agents = agentsResult.structuredContent?.agents;
if (!Array.isArray(agents)) throw new Error('terminal_list_agents smoke returned an invalid payload');
const agent = agents.find((candidate) => candidate?.online === true);
if (!agent?.agent_id) throw new Error('deployment smoke requires at least one connected terminal agent');

let terminalSessionId;
try {
  const surface = await callTool('terminal_surface', {}, initialized.sessionId, 3);
  const surfaceId = surface.structuredContent?.surface_id;
  if (!surfaceId) throw new Error('terminal_surface smoke did not return a surface_id');

  const started = await callTool('terminal_start', {
    agent_id: agent.agent_id,
    surface_id: surfaceId,
    shell: 'bash',
    command: "printf 'terminal-stream-smoke\\n'",
  }, initialized.sessionId, 4);
  terminalSessionId = started.structuredContent?.session_id;
  const streamUrl = started._meta?.terminal_stream?.url;
  if (!terminalSessionId || !streamUrl) throw new Error('terminal_start smoke did not return a terminal stream capability');
  const frame = await fetchFirstSseFrame(streamUrl, { Origin: widgetOrigin });
  if (!frame.includes('data:')) throw new Error(`terminal SSE did not emit a data frame: ${frame.slice(0, 300)}`);
} finally {
  if (terminalSessionId) {
    await callTool('terminal_close', { session_id: terminalSessionId }, initialized.sessionId, 5).catch(() => undefined);
  }
  await callTool('terminal_turn_close', {}, initialized.sessionId, 6).catch(() => undefined);
}

console.log(JSON.stringify({
  ok: true,
  tool: 'terminal_list_agents',
  agent_count: agents.length,
  connected_agent: agent.agent_id,
  widget_origin: widgetOrigin,
  terminal_sse: 'verified',
}));
