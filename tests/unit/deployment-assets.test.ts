import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../..', import.meta.url);

describe('deployment assets', () => {
  it('lets systemd create and protect the server state and log directories', async () => {
    const source = await readFile(new URL('deploy/systemd/chatgpt-terminal-mcp.service.example', root), 'utf8');

    expect(source).toContain('StateDirectory=chatgpt-terminal');
    expect(source).toContain('StateDirectoryMode=0700');
    expect(source).toContain('LogsDirectory=chatgpt-terminal');
    expect(source).toContain('LogsDirectoryMode=0700');
    expect(source).not.toMatch(/^ReadWritePaths=.*chatgpt-terminal/m);
  });

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
