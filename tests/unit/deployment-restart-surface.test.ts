import { describe, expect, it } from 'vitest';
import { TerminalTurnRegistry } from '../../packages/mcp-server/src/turn-registry.js';
import type { RequestIdentity } from '../../packages/mcp-server/src/service.js';

describe('deployment restart surface recovery', () => {
  it('allows terminal_start to rebind the exact surface after MCP restarts between surface and start', async () => {
    const before: RequestIdentity = {
      userId: 'owner', clientId: 'chatgpt', executionProfile: 'owner-full', mcpSessionId: 'mcp-before-restart',
    };
    const firstProcess = new TerminalTurnRegistry(async () => undefined, 60_000);
    const surface = await firstProcess.begin(before);
    firstProcess.dispose();

    const after: RequestIdentity = { ...before, mcpSessionId: 'mcp-after-restart' };
    const secondProcess = new TerminalTurnRegistry(async () => undefined, 60_000);
    const rebound = secondProcess.recover(after, surface.surface_id!);
    expect(rebound.surface_id).toBe(surface.surface_id);
    await secondProcess.activate(after, 'pty-after-deploy');
    expect(secondProcess.current(after)).toEqual(expect.objectContaining({
      surface_id: surface.surface_id, surface_open: true, session_id: 'pty-after-deploy',
    }));
    secondProcess.dispose();
  });
});
