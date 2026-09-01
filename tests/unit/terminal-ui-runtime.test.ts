import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedFs = vi.hoisted(() => ({
  readFile: vi.fn(async () => '<!doctype html><html><head></head><body></body></html>'),
  stat: vi.fn(async (path: string) => ({
    mtimeMs: path.endsWith('/src/main.ts') ? 2_000 : 1_000,
    size: 128,
  })),
}));

vi.mock('node:fs/promises', () => mockedFs);

import { readTerminalUiDocument } from '../../packages/mcp-server/src/ui-runtime.js';

describe('terminal UI runtime artifact contract', () => {
  beforeEach(() => {
    mockedFs.readFile.mockClear();
    mockedFs.stat.mockClear();
  });

  it('refuses to serve a bundle older than the terminal UI runtime source', async () => {
    await expect(readTerminalUiDocument()).rejects.toThrow(/stale/i);
  });
});
