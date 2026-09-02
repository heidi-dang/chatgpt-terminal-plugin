import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalTurnRegistry } from '../../packages/mcp-server/src/turn-registry.js';
import type { RequestIdentity } from '../../packages/mcp-server/src/service.js';

const identity: RequestIdentity = {
  userId: 'user-a',
  clientId: 'client-a',
  executionProfile: 'owner-full',
  mcpSessionId: 'mcp-a',
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

  it('closes every superseded PTY when same-turn activations overlap', async () => {
    const closed: string[] = [];
    let releaseFirstClose!: () => void;
    let markFirstCloseStarted!: () => void;
    const firstCloseBlocked = new Promise<void>((resolve) => { releaseFirstClose = resolve; });
    const firstCloseStarted = new Promise<void>((resolve) => { markFirstCloseStarted = resolve; });
    const registry = new TerminalTurnRegistry(async (_identity, sessionId) => {
      closed.push(sessionId);
      if (sessionId === 'session-1') {
        markFirstCloseStarted();
        await firstCloseBlocked;
      }
    }, 60_000);

    await registry.begin(identity);
    await registry.activate(identity, 'session-1');
    const second = registry.activate(identity, 'session-2');
    await firstCloseStarted;
    const third = registry.activate(identity, 'session-3');
    releaseFirstClose();
    await Promise.all([second, third]);

    expect(closed).toEqual(['session-1', 'session-2']);
    expect(registry.current(identity).session_id).toBe('session-3');
    registry.dispose();
  });

  it('closes a newly-created PTY when its surface is replaced during activation', async () => {
    const closed: string[] = [];
    let releaseOldClose!: () => void;
    let markOldCloseStarted!: () => void;
    const oldCloseBlocked = new Promise<void>((resolve) => { releaseOldClose = resolve; });
    const oldCloseStarted = new Promise<void>((resolve) => { markOldCloseStarted = resolve; });
    const registry = new TerminalTurnRegistry(async (_identity, sessionId) => {
      closed.push(sessionId);
      if (sessionId === 'session-old') {
        markOldCloseStarted();
        await oldCloseBlocked;
      }
    }, 60_000);

    const oldSurface = await registry.begin(identity);
    await registry.activate(identity, 'session-old');
    const activation = registry.activate(identity, 'session-new');
    await oldCloseStarted;
    const queuedActivation = registry.activate(identity, 'session-queued');
    const nextTurn = registry.begin(identity);
    releaseOldClose();

    await expect(activation).rejects.toThrow('Terminal surface closed while replacing its active PTY.');
    await expect(queuedActivation).rejects.toThrow('Terminal surface changed before PTY activation.');
    const nextSurface = await nextTurn;
    expect(closed).toContain('session-new');
    expect(closed).toContain('session-queued');
    expect(nextSurface.surface_id).not.toBe(oldSurface.surface_id);
    expect(registry.current(identity)).toEqual(expect.objectContaining({ surface_id: nextSurface.surface_id, session_id: null }));
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
  it('isolates two concurrent MCP sessions for the same OAuth principal', async () => {
    const closed: string[] = [];
    const registry = new TerminalTurnRegistry(async (_identity, sessionId) => { closed.push(sessionId); }, 60_000);
    const conversationA = { ...identity, mcpSessionId: 'mcp-conversation-a', chatgptSessionId: undefined };
    const conversationB = { ...identity, mcpSessionId: 'mcp-conversation-b', chatgptSessionId: undefined };

    const surfaceA = await registry.begin(conversationA);
    const surfaceB = await registry.begin(conversationB);
    await registry.activate(conversationA, 'pty-a');
    await registry.activate(conversationB, 'pty-b');

    expect(surfaceA.surface_id).not.toBe(surfaceB.surface_id);
    expect(registry.current(conversationA).session_id).toBe('pty-a');
    expect(registry.current(conversationB).session_id).toBe('pty-b');
    expect(closed).toEqual([]);

    await registry.begin(conversationA);
    expect(closed).toEqual(['pty-a']);
    expect(registry.current(conversationB).session_id).toBe('pty-b');
    registry.dispose();
  });

  it('recovers an exact surface capability after an MCP process restart', async () => {
    const first = new TerminalTurnRegistry(async () => undefined, 60_000);
    const surface = await first.begin(identity);
    first.dispose();

    const restartedIdentity = { ...identity, mcpSessionId: 'mcp-after-restart' };
    const restarted = new TerminalTurnRegistry(async () => undefined, 60_000);
    const recovered = restarted.recover(restartedIdentity, surface.surface_id!);

    expect(recovered).toEqual(expect.objectContaining({
      surface_id: surface.surface_id,
      surface_open: true,
      surface_active: false,
      session_id: null,
    }));
    await restarted.activate(restartedIdentity, 'pty-after-restart');
    expect(restarted.current(restartedIdentity).session_id).toBe('pty-after-restart');
    restarted.dispose();
  });

  it('treats already-missing PTYs as successful idempotent cleanup', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = new TerminalTurnRegistry(async () => {
      throw Object.assign(new Error('Terminal session was not found.'), { code: 'SESSION_NOT_FOUND' });
    }, 60_000);

    await registry.begin(identity);
    await registry.activate(identity, 'session-gone');
    await expect(registry.end(identity)).resolves.toEqual(expect.objectContaining({ surface_open: false }));
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    registry.dispose();
  });

  it('still reports real cleanup failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = new TerminalTurnRegistry(async () => {
      throw Object.assign(new Error('Agent is offline.'), { code: 'AGENT_OFFLINE' });
    }, 60_000);

    await registry.begin(identity);
    await registry.activate(identity, 'session-failed');
    await registry.end(identity);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('terminal.turn_cleanup_failed');
    errorSpy.mockRestore();
    registry.dispose();
  });

});
