import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../..', import.meta.url);

describe('deployment assets', () => {
  it('does not ship stale checked-in source archives as deployment assets', async () => {
    const entries = await readdir(new URL('deploy/', root));
    const deployment = await readFile(new URL('docs/deployment.md', root), 'utf8');
    expect(entries.filter((entry) => entry.endsWith('.tgz'))).toEqual([]);
    expect(deployment).toContain('git archive --format=tar.gz');
    expect(deployment).toContain('git diff --quiet && git diff --cached --quiet');
  });

  it('lets systemd create and protect the server state and log directories', async () => {
    const source = await readFile(new URL('deploy/systemd/chatgpt-terminal-mcp.service.example', root), 'utf8');

    expect(source).toContain('StateDirectory=chatgpt-terminal');
    expect(source).toContain('StateDirectoryMode=0700');
    expect(source).toContain('LogsDirectory=chatgpt-terminal');
    expect(source).toContain('LogsDirectoryMode=0700');
    expect(source).not.toMatch(/^ReadWritePaths=.*chatgpt-terminal/m);
  });

  it('documents the same server OS account used by the shipped systemd unit', async () => {
    const unit = await readFile(new URL('deploy/systemd/chatgpt-terminal-mcp.service.example', root), 'utf8');
    const deployment = await readFile(new URL('docs/deployment.md', root), 'utf8');
    const serviceUser = unit.match(/^User=(.+)$/m)?.[1];

    expect(serviceUser).toBeTruthy();
    expect(deployment).toContain(`sudo -u ${serviceUser} node packages/mcp-server/dist/admin.js`);
  });

  it('ships finite production session quotas', async () => {
    const source = await readFile(new URL('deploy/server-environment.example', root), 'utf8');
    const perUser = Number(source.match(/^TERMINAL_MAX_SESSIONS_PER_USER=(\d+)$/m)?.[1]);
    const perAgent = Number(source.match(/^TERMINAL_MAX_SESSIONS_PER_AGENT=(\d+)$/m)?.[1]);

    expect(perUser).toBeGreaterThan(0);
    expect(perAgent).toBeGreaterThan(0);
  });

  it('does not advertise unsupported local-agent queue controls', async () => {
    const source = await readFile(new URL('deploy/local-agent-environment.example', root), 'utf8');

    expect(source).not.toContain('AGENT_CONTROL_QUEUE_LIMIT=');
    expect(source).toContain('TERMINAL_BUFFER_HIGH_WATER_BYTES=');
  });

  it('packages production dependencies without running development-only lifecycle hooks', async () => {
    const source = await readFile(new URL('scripts/package-mcp-release.sh', root), 'utf8');

    expect(source).toContain('pnpm --config.ignore-scripts=true --filter @terminal/mcp-server deploy --prod --legacy');
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
