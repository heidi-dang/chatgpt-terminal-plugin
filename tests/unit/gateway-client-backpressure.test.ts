import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayMessage } from '../../packages/protocol/src/index.js';
import { AgentGatewayClient } from '../../packages/local-agent/src/gateway-client.js';
import type { TerminalAgentApi } from '../../packages/local-agent/src/index.js';
import type { DeviceIdentity } from '../../packages/local-agent/src/device-identity.js';

interface GatewayHarness {
  socket?: WebSocket;
  authenticated: boolean;
  stopped: boolean;
  queuedBytes: number;
  queue: Array<{ payload: string; bytes: number }>;
  send(message: GatewayMessage): void;
  clearBackpressureDrain(): void;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentGatewayClient backpressure', () => {
  it('drains queued control messages in FIFO order after socket pressure clears', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    let bufferedAmount = 400;
    const socket = {
      readyState: WebSocket.OPEN,
      get bufferedAmount() { return bufferedAmount; },
      send(payload: string) { sent.push(payload); },
    } as unknown as WebSocket;
    const client = createClient();
    const harness = client as unknown as GatewayHarness;
    harness.socket = socket;
    harness.authenticated = true;

    const first = { type: 'heartbeat', timestamp: '2026-09-02T03:00:00.000Z' } satisfies GatewayMessage;
    const second = { type: 'heartbeat', timestamp: '2026-09-02T03:00:01.000Z' } satisfies GatewayMessage;
    harness.send(first);
    harness.send(second);

    expect(sent).toEqual([]);
    expect(harness.queue).toHaveLength(2);
    expect(harness.queuedBytes).toBeGreaterThan(0);

    bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(25);

    expect(sent.map((payload) => JSON.parse(payload))).toEqual([first, second]);
    expect(harness.queue).toEqual([]);
    expect(harness.queuedBytes).toBe(0);
    harness.clearBackpressureDrain();
  });

  it('keeps a queued control message pending while pressure remains high', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 400,
      send(payload: string) { sent.push(payload); },
    } as unknown as WebSocket;
    const client = createClient();
    const harness = client as unknown as GatewayHarness;
    harness.socket = socket;
    harness.authenticated = true;

    harness.send({ type: 'heartbeat', timestamp: '2026-09-02T03:00:00.000Z' });
    await vi.advanceTimersByTimeAsync(100);

    expect(sent).toEqual([]);
    expect(harness.queue).toHaveLength(1);
    harness.stopped = true;
    harness.clearBackpressureDrain();
  });
});

function createClient(): AgentGatewayClient {
  return new AgentGatewayClient({} as TerminalAgentApi, {
    url: 'ws://127.0.0.1/agent',
    identity: {} as DeviceIdentity,
    heartbeatMs: 1000,
    reconnectMaxMs: 1000,
    outboundHighWaterBytes: 512,
  });
}
