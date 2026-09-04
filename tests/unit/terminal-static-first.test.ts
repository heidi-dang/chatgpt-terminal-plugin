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
    const runtime = await Promise.all([
      readFile(join(root, 'packages/terminal-ui/src/main.ts'), 'utf8'),
      readFile(join(root, 'packages/terminal-ui/src/bridge.ts'), 'utf8'),
      readFile(join(root, 'packages/terminal-ui/src/stream-controller.ts'), 'utf8'),
    ]).then((parts) => parts.join('\n'));
    expect(runtime).not.toMatch(/react|react-dom|@xterm\/xterm|@xterm\/addon-fit/i);
    expect(runtime).not.toMatch(/@modelcontextprotocol\/ext-apps/);
    expect(runtime).toContain("'ui/initialize'");
    expect(runtime).toContain("'ui/notifications/tool-result'");
    expect(runtime).toContain("'tools/call'");
    expect(runtime).toContain('window.parent.postMessage');
    expect(runtime).toContain('EventSource');
  });

  it('ships terminal syntax colors for both host themes', async () => {
    const css = await readFile(join(root, 'packages/terminal-ui/src/styles.css'), 'utf8');
    expect(css).toContain(':root[data-theme="light"]');
    for (const token of ['.term-keyword', '.term-string', '.term-number', '.term-path', '.term-option', '.term-error', '.term-warning', '.term-success']) {
      expect(css).toContain(token);
    }
  });

  it('keeps the footer inside the card and gives mobile output a bounded scroll viewport', async () => {
    const css = await readFile(join(root, 'packages/terminal-ui/src/styles.css'), 'utf8');
    expect(css).toContain('grid-template-rows: auto minmax(0, 1fr) auto;');
    expect(css).toContain('height:clamp(340px,62dvh,520px);');
    expect(css).toContain('.terminal-frame { min-height:0;padding:8px 7px 7px 9px; }');
    expect(css).toContain('.terminal-output { min-height:0;padding-bottom:10px;font-size:11.25px;line-height:1.35; }');
    expect(css).toContain('overscroll-behavior:contain;');
    expect(css).not.toContain('minmax(0, 68vh)');
    expect(css).not.toContain('safe-area-inset-bottom');
  });

  it('never forces a short-host terminal card taller than the available dynamic viewport', async () => {
    const css = await readFile(join(root, 'packages/terminal-ui/src/styles.css'), 'utf8');
    expect(css).not.toContain('.terminal-shell { height:calc(100dvh - 8px);min-height:280px; }');
    expect(css).toContain('.terminal-shell { height:calc(100dvh - 8px);min-height:min(280px,calc(100dvh - 8px)); }');
  });

  it('reports widget size changes in the ChatGPT openai compatibility path', async () => {
    const runtime = await readFile(join(root, 'packages/terminal-ui/src/bridge.ts'), 'utf8');
    expect(runtime).toMatch(/if \(openAi\) \{[\s\S]*?this\.startAutoResize\(\);[\s\S]*?return;/);
  });

  it('ships accessible output navigation in the static shell', async () => {
    const html = await readFile(join(root, 'packages/terminal-ui/index.html'), 'utf8');
    const css = await readFile(join(root, 'packages/terminal-ui/src/styles.css'), 'utf8');
    expect(html).toContain('id="terminal-jump-to-live"');
    expect(html).toContain('aria-controls="terminal-output"');
    expect(html).toContain('role="log"');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('color-scheme: dark light');
  });

  it('boots the app runtime whenever the static terminal shell exists', async () => {
    const runtime = await readFile(join(root, 'packages/terminal-ui/src/main.ts'), 'utf8');
    expect(runtime).toContain("if (document.querySelector('[data-terminal-static-shell]')) {");
    expect(runtime).not.toContain("document.querySelector('[data-terminal-static-shell]') && (window.parent !== window");
  });

  it('makes every MCP server build regenerate the terminal UI bundle it serves', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'packages/mcp-server/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.build).toContain('@terminal/terminal-ui');
    expect(manifest.scripts?.build).toContain('tsc -b');
  });

  it('avoids concurrent writers to the generated terminal UI bundle during the root build', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.build).toContain("--filter '!@terminal/terminal-ui'");
  });

  it('uses a fresh v13 MCP App resource identity after the terminal layout contract changes', async () => {
    const mcp = await readFile(join(root, 'packages/mcp-server/src/mcp.ts'), 'utf8');
    expect(mcp).toContain("ui://terminal/v13.html");
    expect(mcp).toContain("version: '0.13.0'");
  });
});
