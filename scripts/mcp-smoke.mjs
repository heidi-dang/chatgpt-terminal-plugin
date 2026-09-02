#!/usr/bin/env node

const url = process.env.TERMINAL_SMOKE_URL;
const token = process.env.TERMINAL_SMOKE_TOKEN;
const accessClientId = process.env.TERMINAL_SMOKE_CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.TERMINAL_SMOKE_CF_ACCESS_CLIENT_SECRET;
const localDeploymentSmoke = process.env.TERMINAL_SMOKE_LOCAL === '1';
if (!url || (!localDeploymentSmoke && !token && !(accessClientId && accessClientSecret))) {
  console.error('TERMINAL_SMOKE_URL plus local deployment-smoke mode, a bearer token, or Cloudflare Access service credentials are required.');
  process.exit(64);
}
if ((accessClientId && !accessClientSecret) || (!accessClientId && accessClientSecret)) {
  console.error('Cloudflare Access smoke credentials must be supplied as a complete client ID/secret pair.');
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
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
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
const toolCall = await post({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'terminal_list_agents', arguments: {} },
}, sessionId, protocolVersion);

const result = toolCall.message?.result;
if (!result || typeof result !== 'object') throw new Error('terminal_list_agents returned no MCP result.');
if (result.isError === true) throw new Error(`terminal_list_agents failed: ${resultText(result)}`);
const structured = result.structuredContent;
if (!structured || typeof structured !== 'object' || !Array.isArray(structured.agents)) {
  throw new Error('terminal_list_agents did not return structured agents data.');
}
console.log(`mcp_smoke=ok tool=terminal_list_agents agent_count=${structured.agents.length}`);

async function post(body, sessionId, protocolVersion, expectResponse = true) {
  const headers = { ...baseHeaders };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 1000);
    throw new Error(`MCP smoke HTTP ${response.status}: ${text}`);
  }
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
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
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
