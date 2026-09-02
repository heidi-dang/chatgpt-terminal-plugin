import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TerminalTurnRegistry } from '../../packages/mcp-server/src/turn-registry.js';
import type { RequestIdentity } from '../../packages/mcp-server/src/service.js';

describe('deployment restart surface recovery', () => {
  it('allows terminal_start to rebind the exact persisted surface after MCP restarts between surface and start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-restart-surface-'));
    const statePath = join(root, 'turns.json');
    try {
      const before: RequestIdentity = {
        userId: 'owner', clientId: 'chatgpt', executionProfile: 'owner-full', mcpSessionId: 'mcp-before-restart',
      };
      const firstProcess = await TerminalTurnRegistry.load(async () => undefined, 60_000, statePath);
      const surface = await firstProcess.begin(before);
      firstProcess.dispose();

      const after: RequestIdentity = { ...before, mcpSessionId: 'mcp-after-restart' };
      const secondProcess = await TerminalTurnRegistry.load(async () => undefined, 60_000, statePath);
      const rebound = await secondProcess.recover(after, surface.surface_id!);
      expect(rebound.surface_id).toBe(surface.surface_id);
      expect(rebound.surface_open).toBe(true);
      await secondProcess.activate(after, 'pty-after-deploy');
      expect(secondProcess.current(after)).toEqual(expect.objectContaining({
        surface_id: surface.surface_id, surface_open: true, session_id: 'pty-after-deploy',
      }));
      secondProcess.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
