import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('keeps one surface stable while overlapping PTY replacements serialize', async () => {
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

    const surface = await registry.begin(identity);
    await registry.activate(identity, 'session-old');
    const activation = registry.activate(identity, 'session-new');
    await oldCloseStarted;
    const queuedActivation = registry.activate(identity, 'session-queued');
    const repeatedSurface = registry.begin(identity);
    releaseOldClose();

    await Promise.all([activation, queuedActivation]);
    expect((await repeatedSurface).surface_id).toBe(surface.surface_id);
    expect(closed).toEqual(['session-old', 'session-new']);
    expect(registry.current(identity)).toEqual(expect.objectContaining({ surface_id: surface.surface_id, session_id: 'session-queued' }));
    registry.dispose();
  });

  it('treats repeated surface opens as idempotent and does not kill the active PTY', async () => {
    const closed: string[] = [];
    const registry = new TerminalTurnRegistry(async (_identity, sessionId) => { closed.push(sessionId); }, 60_000);

    const first = await registry.begin(identity);
    await registry.activate(identity, 'session-old');
    const repeated = await registry.begin(identity);

    expect(repeated.surface_id).toBe(first.surface_id);
    expect(repeated.session_id).toBe('session-old');
    expect(closed).toEqual([]);
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

  it('keeps the original widget surface reusable across later assistant turns', async () => {
    const registry = new TerminalTurnRegistry(async () => undefined, 60_000);

    const first = await registry.begin(identity);
    await registry.end(identity);
    const second = await registry.begin(identity);

    expect(second.surface_id).toBe(first.surface_id);
    expect(registry.status(identity, first.surface_id!)).toEqual(expect.objectContaining({ surface_open: true, session_id: null }));
    registry.dispose();
  });

  it('isolates concurrent MCP sessions even when OAuth conversation metadata is identical', async () => {
    const closed: string[] = [];
    const registry = new TerminalTurnRegistry(async (_identity, sessionId) => { closed.push(sessionId); }, 60_000);
    const conversationA: RequestIdentity = { ...identity, mcpSessionId: 'mcp-a', chatgptSessionId: 'shared-oauth-session' };
    const conversationB: RequestIdentity = { ...identity, mcpSessionId: 'mcp-b', chatgptSessionId: 'shared-oauth-session' };

    const surfaceA = await registry.begin(conversationA);
    await registry.activate(conversationA, 'session-a');
    const surfaceB = await registry.begin(conversationB);
    await registry.activate(conversationB, 'session-b');

    expect(surfaceA.surface_id).not.toBe(surfaceB.surface_id);
    expect(closed).toEqual([]);
    expect(registry.current(conversationA).session_id).toBe('session-a');
    expect(registry.current(conversationB).session_id).toBe('session-b');

    await registry.end(conversationA);
    expect(closed).toEqual([]);
    expect(registry.current(conversationA)).toEqual(expect.objectContaining({ surface_id: surfaceA.surface_id, surface_open: true, surface_active: true, session_id: 'session-a' }));
    expect(registry.current(conversationB)).toEqual(expect.objectContaining({ surface_open: true, session_id: 'session-b' }));
    await registry.clearActive(conversationA);
    expect(closed).toEqual(['session-a']);
    registry.dispose();
  });

  it('migrates persisted v1 surface state without losing the existing widget capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-turn-v1-migration-'));
    const statePath = join(root, 'turns.json');
    const surfaceId = '77777777-7777-4777-8777-777777777777';
    const legacyIdentity: RequestIdentity = { ...identity, mcpSessionId: 'mcp-legacy', chatgptSessionId: undefined };

    try {
      await writeFile(statePath, `${JSON.stringify({
        version: 1,
        records: [{
          identity: legacyIdentity,
          surfaceId,
          sessionId: null,
          expiresAt: Date.now() + 60_000,
        }],
      })}\n`);

      const registry = await TerminalTurnRegistry.load(async () => undefined, 5_000, statePath, 20_000);
      expect(registry.current(legacyIdentity)).toEqual(expect.objectContaining({
        surface_id: surfaceId,
        surface_open: true,
        surface_active: false,
        session_id: null,
      }));
      const migrated = JSON.parse(await readFile(statePath, 'utf8')) as { version: number; records: unknown[] };
      expect(migrated.version).toBe(2);
      expect(migrated.records).toHaveLength(1);
      registry.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers the exact persisted surface after an MCP process restart before terminal_start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-turn-restart-'));
    const statePath = join(root, 'turns.json');
    const closed: string[] = [];
    const closeTerminal = async (_identity: RequestIdentity, sessionId: string) => { closed.push(sessionId); };
    const beforeRestart: RequestIdentity = { ...identity, mcpSessionId: 'mcp-before', chatgptSessionId: undefined };
    const afterRestart: RequestIdentity = { ...identity, mcpSessionId: 'mcp-after', chatgptSessionId: undefined };

    try {
      const firstProcess = await TerminalTurnRegistry.load(closeTerminal, 60_000, statePath);
      const surface = await firstProcess.begin(beforeRestart);
      firstProcess.dispose();

      const secondProcess = await TerminalTurnRegistry.load(closeTerminal, 60_000, statePath);
      const recovered = await secondProcess.recover(afterRestart, surface.surface_id!);
      expect(recovered).toEqual(expect.objectContaining({
        surface_id: surface.surface_id,
        surface_open: true,
        surface_active: false,
        session_id: null,
      }));

      await secondProcess.activate(afterRestart, 'session-after-restart');
      expect(secondProcess.current(afterRestart).session_id).toBe('session-after-restart');
      expect(secondProcess.current(beforeRestart).surface_open).toBe(false);
      expect(closed).toEqual([]);
      await secondProcess.end(afterRestart);
      expect(closed).toEqual([]);
      await secondProcess.clearActive(afterRestart);
      secondProcess.dispose();
      expect(closed).toEqual(['session-after-restart']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires the exact surface capability for modern MCP-session restart recovery', async () => {
    const registry = new TerminalTurnRegistry(async () => undefined, 60_000);
    const beforeRestart: RequestIdentity = { ...identity, mcpSessionId: 'mcp-before' };
    const afterRestart: RequestIdentity = { ...identity, mcpSessionId: 'mcp-after' };

    const surface = await registry.begin(beforeRestart);
    await expect(registry.recover(afterRestart)).resolves.toEqual(expect.objectContaining({ surface_open: false }));
    expect(registry.current(beforeRestart)).toEqual(expect.objectContaining({ surface_id: surface.surface_id, surface_open: true }));
    registry.dispose();
  });

  it('refuses ambiguous implicit recovery when two conversations from the same principal are open', async () => {
    const registry = new TerminalTurnRegistry(async () => undefined, 60_000);
    const conversationA: RequestIdentity = { ...identity, mcpSessionId: 'mcp-a' };
    const conversationB: RequestIdentity = { ...identity, mcpSessionId: 'mcp-b' };
    const afterRestart: RequestIdentity = { ...identity, mcpSessionId: 'mcp-new' };

    await registry.begin(conversationA);
    await registry.begin(conversationB);
    await expect(registry.recover(afterRestart)).resolves.toEqual(expect.objectContaining({ surface_open: false }));
    expect(registry.current(conversationA).surface_open).toBe(true);
    expect(registry.current(conversationB).surface_open).toBe(true);
    registry.dispose();
  });

  it('keeps the active PTY attached when the assistant turn yields for user input', async () => {
    const closed: string[] = [];
    const registry = new TerminalTurnRegistry(async (_identity, sessionId) => { closed.push(sessionId); }, 60_000);

    const surface = await registry.begin(identity);
    await registry.activate(identity, 'session-1');
    const yielded = await registry.end(identity);

    expect(closed).toEqual([]);
    expect(yielded).toEqual(expect.objectContaining({ surface_id: surface.surface_id, surface_open: true, surface_active: true, session_id: 'session-1' }));
    expect(registry.current(identity)).toEqual(expect.objectContaining({ surface_id: surface.surface_id, surface_open: true, surface_active: true, session_id: 'session-1' }));
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

  it('renews an active PTY lease from matching model-side terminal activity', async () => {
    vi.useFakeTimers();
    const closed: string[] = [];
    const registry = new TerminalTurnRegistry(async (_identity, sessionId) => { closed.push(sessionId); }, 5_000, undefined, 20_000);

    await registry.begin(identity);
    await registry.activate(identity, 'session-1');
    await vi.advanceTimersByTimeAsync(4_000);
    registry.touch(identity, 'session-1');
    await vi.advanceTimersByTimeAsync(4_000);

    expect(closed).toEqual([]);
    expect(registry.current(identity).session_id).toBe('session-1');
    registry.touch(identity, 'different-session');
    await vi.advanceTimersByTimeAsync(1_001);
    expect(closed).toEqual(['session-1']);
    expect(registry.current(identity).surface_open).toBe(true);
    registry.dispose();
  });

  it('renews an active PTY lease from an authenticated stream session without MCP-session identity', async () => {
    vi.useFakeTimers();
    const closed: string[] = [];
    const registry = new TerminalTurnRegistry(async (_identity, sessionId) => { closed.push(sessionId); }, 5_000, undefined, 20_000);

    await registry.begin(identity);
    await registry.activate(identity, 'session-stream');
    await vi.advanceTimersByTimeAsync(4_000);
    registry.touchSession('user-a', 'session-stream');
    await vi.advanceTimersByTimeAsync(4_000);

    expect(closed).toEqual([]);
    expect(registry.current(identity).session_id).toBe('session-stream');
    registry.touchSession('different-user', 'session-stream');
    await vi.advanceTimersByTimeAsync(1_001);
    expect(closed).toEqual(['session-stream']);
    registry.dispose();
  });

  it('expires an abandoned surface even when no PTY was started', async () => {
    vi.useFakeTimers();
    const registry = new TerminalTurnRegistry(async () => undefined, 1_000, undefined, 5_000);

    const surface = await registry.begin(identity);
    expect(registry.status(identity, surface.surface_id!).surface_open).toBe(true);
    await vi.advanceTimersByTimeAsync(5_001);

    expect(registry.current(identity).surface_open).toBe(false);
    registry.dispose();
  });

  it('expires an abandoned PTY after the configured turn lease', async () => {
    vi.useFakeTimers();
    const closed: string[] = [];
    const registry = new TerminalTurnRegistry(async (_identity, sessionId) => { closed.push(sessionId); }, 5_000, undefined, 20_000);

    const surface = await registry.begin(identity);
    await registry.activate(identity, 'session-1');
    await vi.advanceTimersByTimeAsync(5_001);

    expect(closed).toEqual(['session-1']);
    expect(registry.current(identity)).toEqual(expect.objectContaining({ surface_id: surface.surface_id, surface_open: true, session_id: null }));
    registry.dispose();
  });
  it('treats already-missing PTYs as successful idempotent cleanup', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = new TerminalTurnRegistry(async () => {
      throw Object.assign(new Error('Terminal session was not found.'), { code: 'SESSION_NOT_FOUND' });
    }, 60_000);

    await registry.begin(identity);
    await registry.activate(identity, 'session-gone');
    await expect(registry.clearActive(identity)).resolves.toEqual(expect.objectContaining({ surface_open: true, surface_active: false, session_id: null }));
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
    await registry.clearActive(identity);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('terminal.turn_cleanup_failed');
    errorSpy.mockRestore();
    registry.dispose();
  });

});
