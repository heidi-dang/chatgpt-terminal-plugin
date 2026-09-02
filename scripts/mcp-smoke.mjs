#!/usr/bin/env node
/* global process, console, fetch */
const url = process.env.MCP_SMOKE_URL;
const headerName = process.env.MCP_SMOKE_HEADER_NAME;
const token = process.env.MCP_SMOKE_TOKEN;
if (!url || !headerName || !token) {
  console.error('MCP_SMOKE_URL, MCP_SMOKE_HEADER_NAME, and MCP_SMOKE_TOKEN are required');
  process.exit(64);
}

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

function parsePayload(text, contentType) {
  if (contentType.includes('text/event-stream')) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean).at(-1);
    if (!data) throw new Error('MCP SSE response did not contain a data frame');
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

const initialized = await rpc({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'terminal-deploy-smoke', version: '1.0.0' } },
});
if (!initialized.sessionId) throw new Error('MCP initialize did not return mcp-session-id');
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, initialized.sessionId);
const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'terminal_list_agents', arguments: {} } }, initialized.sessionId);
const structured = tools.payload?.result?.structuredContent;
if (!structured || !Array.isArray(structured.agents)) throw new Error('terminal_list_agents smoke returned an invalid payload');
console.log(JSON.stringify({ ok: true, tool: 'terminal_list_agents', agent_count: structured.agents.length }));
