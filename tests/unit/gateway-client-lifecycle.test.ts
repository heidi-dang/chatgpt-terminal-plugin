import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentGatewayClient } from '../../packages/local-agent/src/gateway-client.js';
import { LocalTerminalAgent } from '../../packages/local-agent/src/index.js';
import { GATEWAY_MAX_PAYLOAD_BYTES } from '../../packages/protocol/src/index.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  close = vi.fn();
}

describe('AgentGatewayClient lifecycle', () => {
  it('rejects plaintext WebSocket gateways outside loopback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-gateway-client-transport-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const agent = new LocalTerminalAgent({
      agentId: 'agent-transport', allowedWorkspaceRoots: [root], executionProfile: 'owner-full', shells: ['bash'],
    });
    cleanup.push(() => agent.shutdown());

    expect(() => new AgentGatewayClient(agent, {
      url: 'ws://example.com/agent', identity: {} as never, heartbeatMs: 1_000, reconnectMaxMs: 1_000,
      outboundHighWaterBytes: 1024 * 1024,
    })).toThrow(/wss.*loopback/i);
    expect(() => new AgentGatewayClient(agent, {
      url: 'ws://127.0.0.1:8787/agent', identity: {} as never, heartbeatMs: 1_000, reconnectMaxMs: 1_000,
      outboundHighWaterBytes: 1024 * 1024,
    })).not.toThrow();
  });
  it('keeps process features available across a transient gateway disconnect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-gateway-client-reconnect-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const agent = new LocalTerminalAgent({
      agentId: 'agent-reconnect', allowedWorkspaceRoots: [root], executionProfile: 'owner-full', shells: ['bash'],
    });
    cleanup.push(() => agent.shutdown());
    const client = new AgentGatewayClient(agent, {
      url: 'ws://127.0.0.1/', identity: {} as never, heartbeatMs: 1_000, reconnectMaxMs: 1_000,
      outboundHighWaterBytes: 1024 * 1024,
    });
    const socket = new FakeSocket();
    const internal = client as unknown as { socket: WebSocket; waitUntilClosed(): Promise<void> };
    internal.socket = socket as unknown as WebSocket;

    const disconnected = internal.waitUntilClosed();
    socket.emit('close');
    await disconnected;

    const output = await agent.executeCode('user-a', {
      execution_id: randomUUID(), runtime: 'bash', cwd: root, code: "printf 'after-reconnect'", timeout_ms: 2_000,
    }, 'owner-full');
    expect(output.stdout).toBe('after-reconnect');
    expect(output.exit_code).toBe(0);
  });



  it('closes a socket that fails gateway authentication before reconnecting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-gateway-client-auth-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const agent = new LocalTerminalAgent({
      agentId: 'agent-auth', allowedWorkspaceRoots: [root], executionProfile: 'owner-full', shells: ['bash'],
    });
    cleanup.push(() => agent.shutdown());
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unable to allocate gateway-client auth test port.');
    server.once('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'auth.accepted', server_time: new Date().toISOString() }));
    });
    const client = new AgentGatewayClient(agent, {
      url: `ws://127.0.0.1:${address.port}/`, identity: { deviceId: 'device-auth-test' } as never,
      heartbeatMs: 1_000, reconnectMaxMs: 500, outboundHighWaterBytes: 1024 * 1024,
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cleanup.push(() => errorSpy.mockRestore());
    const run = client.start();
    let rejectedSocketWasOpen = true;
    try {
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('agent.gateway_disconnected')));
      rejectedSocketWasOpen = (client as unknown as { socket?: WebSocket }).socket?.readyState === WebSocket.OPEN;
    } finally {
      client.stop();
      await run;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(rejectedSocketWasOpen).toBe(false);
  });

  it('rejects oversized authenticated gateway frames before application parsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-gateway-client-payload-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const agent = new LocalTerminalAgent({
      agentId: 'agent-payload', allowedWorkspaceRoots: [root], executionProfile: 'owner-full', shells: ['bash'],
    });
    cleanup.push(() => agent.shutdown());
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unable to allocate gateway-client payload test port.');
    let resolveClose!: (code: number) => void;
    const closed = new Promise<number>((resolve) => { resolveClose = resolve; });
    server.once('connection', (socket) => {
      const now = Date.now();
      socket.send(JSON.stringify({
        type: 'auth.challenge', nonce: randomUUID(),
        issued_at: new Date(now).toISOString(), expires_at: new Date(now + 10_000).toISOString(),
      }));
      let authenticated = false;
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type?: string };
        if (!authenticated && message.type === 'auth.proof') {
          authenticated = true;
          socket.send(JSON.stringify({ type: 'auth.accepted', server_time: new Date().toISOString() }));
          return;
        }
        if (authenticated && message.type === 'agent.register') {
          socket.send(JSON.stringify({
            type: 'heartbeat', timestamp: new Date().toISOString(), padding: 'x'.repeat(GATEWAY_MAX_PAYLOAD_BYTES + 1024 * 1024),
          }));
        }
      });
      socket.once('close', (code) => resolveClose(code));
    });
    const client = new AgentGatewayClient(agent, {
      url: `ws://127.0.0.1:${address.port}/`,
      identity: { deviceId: 'device-payload-test', signChallenge: () => 'signature' } as never,
      heartbeatMs: 1_000, reconnectMaxMs: 500, outboundHighWaterBytes: 1024 * 1024,
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cleanup.push(() => errorSpy.mockRestore());
    const run = client.start();
    const closeCode = await Promise.race([closed, new Promise<number>((resolve) => setTimeout(() => resolve(0), 2_000))]);
    client.stop();
    await run;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(closeCode).toBe(1009);
  });

  it('stops promptly while waiting in reconnect backoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-gateway-client-stop-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const agent = new LocalTerminalAgent({
      agentId: 'agent-stop', allowedWorkspaceRoots: [root], executionProfile: 'owner-full', shells: ['bash'],
    });
    cleanup.push(() => agent.shutdown());
    const client = new AgentGatewayClient(agent, {
      url: 'ws://127.0.0.1:1/', identity: {} as never, heartbeatMs: 1_000, reconnectMaxMs: 500,
      outboundHighWaterBytes: 1024 * 1024,
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cleanup.push(() => errorSpy.mockRestore());
    const run = client.start();
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('agent.gateway_disconnected')));

    client.stop();
    const stoppedPromptly = await Promise.race([
      run.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    await run;

    expect(stoppedPromptly).toBe(true);
  });
});
