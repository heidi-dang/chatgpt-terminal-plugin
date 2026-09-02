import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const workflow = new URL('../../.github/workflows/quality.yml', import.meta.url);

describe('quality workflow', () => {
  it('runs the complete mandatory repository gate for pull requests to main', async () => {
    const source = await readFile(workflow, 'utf8');

    expect(source).toContain('pull_request:');
    expect(source).toContain('branches: [main]');
    expect(source).toContain('uses: actions/checkout@v4');
    expect(source).toContain('uses: pnpm/action-setup@v4');
    expect(source).toContain('uses: actions/setup-node@v4');
    expect(source).toContain('run: pnpm install --frozen-lockfile');
    expect(source).toContain('run: pnpm typecheck');
    expect(source).toContain('run: pnpm lint');
    expect(source).toContain('run: pnpm test');
    expect(source).toContain('run: pnpm test:e2e');
    expect(source).toContain('run: pnpm build');
  });
});


const deployWorkflow = new URL('../../.github/workflows/deploy-production.yml', import.meta.url);

describe('production deployment workflow', () => {
  it('uses single-flight deployment and a real authenticated MCP tool smoke', async () => {
    const source = await readFile(deployWorkflow, 'utf8');
    expect(source).toContain('group: terminal-mcp-production');
    expect(source).toContain('cancel-in-progress: false');
    expect(source).toContain('TERMINAL_MCP_URL');
    expect(source).toContain('TERMINAL_SMOKE_TOKEN');
    expect(source).toContain('node scripts/mcp-smoke.mjs');
  });
});
