import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentGatewayClient } from '../../packages/local-agent/src/gateway-client.js';
import { LocalTerminalAgent } from '../../packages/local-agent/src/index.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  close = vi.fn();
}

describe('AgentGatewayClient lifecycle', () => {
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
