import { createServer } from 'node:http';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../packages/mcp-server/src/config.js';
import { createTerminalHttpRuntime } from '../../packages/mcp-server/src/http.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('MCP HTTP authentication isolation', () => {
  it('binds an MCP transport session to both authenticated user and client ID', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    Object.assign(jwk, { kid: 'test-key', alg: 'RS256', use: 'sig' });

    const jwksServer = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await listen(jwksServer);
    cleanup.push(() => closeServer(jwksServer));
    const jwksAddress = jwksServer.address();
    if (!jwksAddress || typeof jwksAddress === 'string') throw new Error('Unable to allocate JWKS port.');

    const mcpPort = await freePort();
    const issuer = 'https://issuer.example';
    const audience = 'terminal-mcp-test';
    const config = loadConfig({
      NODE_ENV: 'test',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(mcpPort),
      MCP_PUBLIC_URL: `http://127.0.0.1:${mcpPort}/mcp`,
      MCP_AUTH_MODE: 'jwt',
      OAUTH_ISSUER: issuer,
      OAUTH_JWKS_URL: `http://127.0.0.1:${jwksAddress.port}/jwks`,
      OAUTH_AUDIENCE: audience,
      OAUTH_REQUIRED_SCOPES: 'terminal',
      STREAM_TOKEN_SECRET: 'http-isolation-stream-secret-0123456789',
      REQUESTS_PER_MINUTE: '1000',
    });
    const runtime = await createTerminalHttpRuntime(config);
    await new Promise<void>((resolve, reject) => {
      runtime.httpServer.once('error', reject);
      runtime.httpServer.listen(mcpPort, '127.0.0.1', resolve);
    });
    cleanup.push(() => runtime.close());

    const tokenA = await token(privateKey, issuer, audience, 'user-a', 'client-a');
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
      authProvider: { token: async () => tokenA },
    });
    const client = new Client({ name: 'isolation-test', version: '1.0.0' });
    await client.connect(transport);
    cleanup.push(() => client.close());
    expect(transport.sessionId).toBeTruthy();

    const tokenOtherUser = await token(privateKey, issuer, audience, 'user-b', 'client-a');
    const otherUserResponse = await crossPrincipalRequest(mcpPort, transport.sessionId!, tokenOtherUser);
    expect(otherUserResponse.status).toBe(403);
    expect(await otherUserResponse.text()).toMatch(/not owned by the authenticated principal/i);

    const tokenOtherClient = await token(privateKey, issuer, audience, 'user-a', 'client-b');
    const otherClientResponse = await crossPrincipalRequest(mcpPort, transport.sessionId!, tokenOtherClient);
    expect(otherClientResponse.status).toBe(403);
    expect(await otherClientResponse.text()).toMatch(/not owned by the authenticated principal/i);
  });

  it('accepts only a valid Cloudflare Access assertion in cloudflare-access mode', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    Object.assign(jwk, { kid: 'cloudflare-test-key', alg: 'RS256', use: 'sig' });

    const jwksServer = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await listen(jwksServer);
    cleanup.push(() => closeServer(jwksServer));
    const jwksAddress = jwksServer.address();
    if (!jwksAddress || typeof jwksAddress === 'string') throw new Error('Unable to allocate JWKS port.');

    const mcpPort = await freePort();
    const issuer = 'https://access.example.cloudflareaccess.com';
    const audience = 'cloudflare-access-terminal-test';
    const config = loadConfig({
      NODE_ENV: 'test',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(mcpPort),
      MCP_PUBLIC_URL: `http://127.0.0.1:${mcpPort}/mcp`,
      MCP_AUTH_MODE: 'cloudflare-access',
      OAUTH_ISSUER: issuer,
      OAUTH_JWKS_URL: `http://127.0.0.1:${jwksAddress.port}/jwks`,
      OAUTH_AUDIENCE: audience,
      OAUTH_REQUIRED_SCOPES: '',
      OAUTH_ALLOW_SCOPELESS_TOKENS: 'true',
      OAUTH_USER_ID_CLAIM: 'email',
      STREAM_TOKEN_SECRET: 'cloudflare-access-stream-secret-0123456789',
      REQUESTS_PER_MINUTE: '1000',
    });
    const runtime = await createTerminalHttpRuntime(config);
    await new Promise<void>((resolve, reject) => {
      runtime.httpServer.once('error', reject);
      runtime.httpServer.listen(mcpPort, '127.0.0.1', resolve);
    });
    cleanup.push(() => runtime.close());

    const assertionA = await cloudflareAccessToken(privateKey, issuer, audience, 'subject-a', 'user-a@example.com');
    const bearerOnly = await initializeWithHeaders(mcpPort, { authorization: `Bearer ${assertionA}` });
    expect(bearerOnly.status).toBe(401);
    expect(await bearerOnly.text()).toMatch(/cloudflare_access_assertion_required/i);

    const initialized = await initializeWithHeaders(mcpPort, { 'cf-access-jwt-assertion': assertionA });
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const assertionB = await cloudflareAccessToken(privateKey, issuer, audience, 'subject-b', 'user-b@example.com');
    const crossUser = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: 'POST',
      headers: {
        'cf-access-jwt-assertion': assertionB,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(crossUser.status).toBe(403);
    expect(await crossUser.text()).toMatch(/not owned by the authenticated principal/i);
  });
});

async function token(
  privateKey: KeyObject,
  issuer: string,
  audience: string,
  subject: string,
  clientId: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlJson({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
  const payload = base64urlJson({
    iss: issuer,
    aud: audience,
    sub: subject,
    iat: now,
    exp: now + 300,
    scope: 'terminal',
    client_id: clientId,
    execution_profile: 'developer',
  });
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
}

async function cloudflareAccessToken(
  privateKey: KeyObject,
  issuer: string,
  audience: string,
  subject: string,
  email: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlJson({ alg: 'RS256', kid: 'cloudflare-test-key', typ: 'JWT' });
  const payload = base64urlJson({
    iss: issuer,
    aud: audience,
    sub: subject,
    email,
    iat: now,
    exp: now + 300,
  });
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function initializeWithHeaders(port: number, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'cloudflare-access-test', version: '1.0.0' },
      },
    }),
  });
}

function crossPrincipalRequest(port: number, sessionId: string, bearer: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate MCP port.');
  const port = address.port;
  await closeServer(server);
  return port;
}
