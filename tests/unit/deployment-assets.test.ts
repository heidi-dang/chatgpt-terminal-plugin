import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../..', import.meta.url);

describe('deployment assets', () => {
  it('runs built service entrypoints without requiring pnpm at runtime', async () => {
    const cases = [
      ['deploy/systemd/chatgpt-terminal-mcp.service.example', 'packages/mcp-server/dist/cli.js'],
      ['deploy/systemd/chatgpt-terminal-agent.service.example', 'packages/local-agent/dist/cli.js'],
    ] as const;

    for (const [path, entrypoint] of cases) {
      const source = await readFile(new URL(path, root), 'utf8');
      expect(source).toContain(`ExecStart=/usr/bin/env node ${entrypoint}`);
      expect(source).not.toMatch(/^ExecStart=.*\bpnpm\b/m);
    }
  });
});
