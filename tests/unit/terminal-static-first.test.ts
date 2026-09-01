import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('terminal UI static-first contract', () => {
  it('renders a visible watch-only shell before JavaScript executes', async () => {
    const html = await readFile(join(root, 'packages/terminal-ui/index.html'), 'utf8');
    expect(html).toContain('data-terminal-static-shell');
    expect(html).toContain('CHATGPT LIVE TERMINAL');
    expect(html).toContain('Terminal UI ready');
    expect(html).toContain('id="terminal-output"');
    expect(html.indexOf('data-terminal-static-shell')).toBeLessThan(html.indexOf('<script'));
    expect(html).not.toContain('<div id="root"></div>');
  });

  it('uses a lightweight vanilla runtime instead of React/xterm boot dependencies', async () => {
    const runtime = await readFile(join(root, 'packages/terminal-ui/src/main.ts'), 'utf8');
    expect(runtime).not.toMatch(/react|react-dom|@xterm\/xterm|@xterm\/addon-fit/i);
    expect(runtime).not.toMatch(/@modelcontextprotocol\/ext-apps/);
    expect(runtime).toContain("'ui/initialize'");
    expect(runtime).toContain("'ui/notifications/tool-result'");
    expect(runtime).toContain("'tools/call'");
    expect(runtime).toContain('window.parent.postMessage');
    expect(runtime).toContain('EventSource');
  });

  it('uses a fresh v8 MCP App resource identity', async () => {
    const mcp = await readFile(join(root, 'packages/mcp-server/src/mcp.ts'), 'utf8');
    expect(mcp).toContain("ui://terminal/v8.html");
    expect(mcp).toContain("version: '0.8.0'");
  });
});
