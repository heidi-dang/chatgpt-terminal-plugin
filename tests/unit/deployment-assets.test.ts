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

  it('bounds production shutdown and persists restart-recovery state', async () => {
    const unit = await readFile(new URL('deploy/systemd/chatgpt-terminal-mcp.service.example', root), 'utf8');
    const environment = await readFile(new URL('deploy/server-environment.example', root), 'utf8');
    const timeout = Number(unit.match(/^TimeoutStopSec=(\d+)$/m)?.[1]);

    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(5);
    expect(unit).toContain('KillMode=mixed');
    expect(unit).toContain('WorkingDirectory=/opt/chatgpt-terminal-plugin/current');
    expect(environment).toContain('MCP_SHUTDOWN_GRACE_MS=2000');
    expect(environment).toContain('TERMINAL_TURN_STATE_PATH=/var/lib/chatgpt-terminal/terminal-turns.json');
    expect(environment).toContain('TERMINAL_SURFACE_RETENTION_MS=2592000000');
  });

  it('keeps enrollment credentials out of the shipped systemd unit', async () => {
    const unit = await readFile(new URL('deploy/systemd/chatgpt-terminal-agent.service.example', root), 'utf8');

    expect(unit).toContain('EnvironmentFile=%h/.config/chatgpt-terminal-plugin/agent.env');
    expect(unit).not.toMatch(/^Environment=AGENT_ENROLLMENT_TOKEN=/m);
  });

  it('ships a deployment single-flight gate and authenticated MCP functional smoke', async () => {
    const deploy = await readFile(new URL('deploy/immutable-deploy.sh', root), 'utf8');
    const workflow = await readFile(new URL('.github/workflows/deploy-production.yml', root), 'utf8');
    const smoke = await readFile(new URL('scripts/mcp-smoke.mjs', root), 'utf8');

    expect(workflow).toContain('group: terminal-mcp-production');
    expect(workflow).toContain('TERMINAL_SMOKE_BEARER_TOKEN');
    expect(workflow).toContain('Public ChatGPT widget boundary smoke');
    expect(workflow).toContain('TERMINAL_SMOKE_REQUIRE_AGENT=1');
    expect(workflow).not.toContain('Public OAuth smoke skipped');
    expect(deploy).toContain('flock -n 9');
    expect(deploy).toContain('TERMINAL_SMOKE_LOCAL=1');
    expect(deploy).toContain('TERMINAL_SMOKE_WIDGET_ORIGIN=');
    expect(deploy).toContain('scripts/mcp-smoke.mjs');
    expect(smoke).toContain("callTool('terminal_list_agents'");
    expect(smoke).toContain("callTool('terminal_start'");
    expect(smoke).toContain("callTool('terminal_write'");
    expect(smoke).toContain('fetchFirstSseFrame');
    expect(smoke).toContain("'x-terminal-deployment-smoke': '1'");
  });

  it('does not advertise unsupported local-agent queue controls', async () => {
    const source = await readFile(new URL('deploy/local-agent-environment.example', root), 'utf8');

    expect(source).not.toContain('AGENT_CONTROL_QUEUE_LIMIT=');
    expect(source).toContain('TERMINAL_BUFFER_HIGH_WATER_BYTES=');
  });

  it('packages production dependencies without running development-only lifecycle hooks', async () => {
    const source = await readFile(new URL('scripts/package-mcp-release.sh', root), 'utf8');

    expect(source).toContain('pnpm --config.ignore-scripts=true --filter @terminal/mcp-server deploy --prod --legacy');
    expect(source).toContain('HUSKY=0 pnpm --filter @terminal/local-agent deploy --prod --legacy');
    expect(source).toContain('__TERMINAL_NATIVE_PTY_OK__');
    expect(source).toContain('NATIVE_RUNTIME_VERIFIED');
    expect(source).toContain('cp -p scripts/mcp-smoke.mjs');
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
