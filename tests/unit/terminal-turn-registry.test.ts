import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalTurnRegistry } from '../../packages/mcp-server/src/turn-registry.js';
import type { RequestIdentity } from '../../packages/mcp-server/src/service.js';

const identity: RequestIdentity = {
  userId: 'user-a',
  clientId: 'client-a',
  executionProfile: 'owner-full',
  chatgptSessionId: 'chat-a',
};

afterEach(() => vi.useRealTimers());

describe('TerminalTurnRegistry', () => {
  it('replaces the active PTY for one ChatGPT conversation instead of retaining both', async () => {
    const closed: string[] = [];
    const registry = new TerminalTurnRegistry(async (_identity, sessionId) => { closed.push(sessionId); }, 60_000);

    await registry.begin(identity);
    await registry.activate(identity, 'session-1');
    await registry.activate(identity, 'session-2');

    expect(closed).toEqual(['session-1']);
    expect(registry.current(identity)).toEqual(expect.objectContaining({ session_id: 'session-2' }));
    registry.dispose();
  });

  it('closes a stale PTY when a fresh assistant turn opens its one terminal surface', async () => {
    const closed: string[] = [];
    const registry = new TerminalTurnRegistry(async (_identity, sessionId) => { closed.push(sessionId); }, 60_000);

    await registry.begin(identity);
    await registry.activate(identity, 'session-old');
    const next = await registry.begin(identity);

    expect(closed).toEqual(['session-old']);
    expect(next.session_id).toBeNull();
    expect(registry.current(identity).session_id).toBeNull();
    registry.dispose();
  });

  it('releases the current PTY while keeping the one turn surface open for replacement', async () => {
    const closed: string[] = [];
    const registry = new TerminalTurnRegistry(async (_identity, sessionId) => { closed.push(sessionId); }, 60_000);

    const surface = await registry.begin(identity);
    await registry.activate(identity, 'session-1');
    const released = await registry.clearActive(identity);

    expect(closed).toEqual(['session-1']);
    expect(released).toEqual(expect.objectContaining({ surface_id: surface.surface_id, surface_open: true, surface_active: false, session_id: null }));
    registry.dispose();
  });

  it('invalidates an older widget surface so it cannot follow a later prompt', async () => {
    const registry = new TerminalTurnRegistry(async () => undefined, 60_000);

    const first = await registry.begin(identity);
    const second = await registry.begin(identity);

    expect(second.surface_id).not.toBe(first.surface_id);
    expect(registry.status(identity, first.surface_id)).toEqual(expect.objectContaining({ surface_open: false, session_id: null }));
    expect(registry.status(identity, second.surface_id)).toEqual(expect.objectContaining({ surface_open: true, session_id: null }));
    registry.dispose();
  });

  it('closes the active PTY when the assistant turn ends', async () => {
    const closed: string[] = [];
    const registry = new TerminalTurnRegistry(async (_identity, sessionId) => { closed.push(sessionId); }, 60_000);

    await registry.begin(identity);
    await registry.activate(identity, 'session-1');
    await registry.end(identity);

    expect(closed).toEqual(['session-1']);
    expect(registry.current(identity).session_id).toBeNull();
    registry.dispose();
  });

  it('renews the active PTY lease when its exact surface sends a heartbeat', async () => {
    vi.useFakeTimers();
    const closed: string[] = [];
    const registry = new TerminalTurnRegistry(async (_identity, sessionId) => { closed.push(sessionId); }, 5_000);

    const surface = await registry.begin(identity);
    await registry.activate(identity, 'session-1');
    await vi.advanceTimersByTimeAsync(4_000);
    registry.status(identity, surface.surface_id!);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(closed).toEqual([]);
    expect(registry.current(identity).session_id).toBe('session-1');
    await vi.advanceTimersByTimeAsync(1_001);
    expect(closed).toEqual(['session-1']);
    registry.dispose();
  });

  it('expires an abandoned surface even when no PTY was started', async () => {
    vi.useFakeTimers();
    const registry = new TerminalTurnRegistry(async () => undefined, 5_000);

    const surface = await registry.begin(identity);
    expect(registry.status(identity, surface.surface_id!).surface_open).toBe(true);
    await vi.advanceTimersByTimeAsync(5_001);

    expect(registry.current(identity).surface_open).toBe(false);
    registry.dispose();
  });

  it('expires an abandoned PTY after the configured turn lease', async () => {
    vi.useFakeTimers();
    const closed: string[] = [];
    const registry = new TerminalTurnRegistry(async (_identity, sessionId) => { closed.push(sessionId); }, 5_000);

    await registry.begin(identity);
    await registry.activate(identity, 'session-1');
    await vi.advanceTimersByTimeAsync(5_001);

    expect(closed).toEqual(['session-1']);
    expect(registry.current(identity).session_id).toBeNull();
    registry.dispose();
  });
});
