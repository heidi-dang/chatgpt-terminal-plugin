import { watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TerminalUiDocument { html: string; version: string }
export interface TerminalUiStyles { css: string; version: string }

export const TERMINAL_UI_HTML_PATH = fileURLToPath(new URL('../../terminal-ui/dist/index.html', import.meta.url));
export const TERMINAL_UI_SOURCE_PATH = fileURLToPath(new URL('../../terminal-ui/src/main.ts', import.meta.url));
export const TERMINAL_UI_STYLES_PATH = fileURLToPath(new URL('../../terminal-ui/src/styles.css', import.meta.url));

export async function readTerminalUiDocument(): Promise<TerminalUiDocument> {
  try {
    const [html, info, sourceInfo] = await Promise.all([
      readFile(TERMINAL_UI_HTML_PATH, 'utf8'),
      stat(TERMINAL_UI_HTML_PATH),
      stat(TERMINAL_UI_SOURCE_PATH),
    ]);
    if (sourceInfo.mtimeMs > info.mtimeMs) {
      throw new Error('Terminal UI bundle is stale because the runtime source is newer than dist/index.html.');
    }
    const version = `${Math.trunc(info.mtimeMs)}-${info.size}`;
    return { html: injectBuildVersion(html, version), version };
  } catch (error) {
    throw new Error(`Terminal UI bundle is unavailable. Run the terminal-ui build first: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readTerminalUiStyles(): Promise<TerminalUiStyles> {
  try {
    const [css, info] = await Promise.all([readFile(TERMINAL_UI_STYLES_PATH, 'utf8'), stat(TERMINAL_UI_STYLES_PATH)]);
    return { css, version: `${Math.trunc(info.mtimeMs)}-${info.size}` };
  } catch (error) {
    throw new Error(`Terminal UI stylesheet is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function watchTerminalUiStyles(onVersion: (version: string) => void): () => void {
  let watcher: FSWatcher | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let closed = false;
  const directory = dirname(TERMINAL_UI_STYLES_PATH);
  const filename = basename(TERMINAL_UI_STYLES_PATH);
  const publish = () => {
    void stat(TERMINAL_UI_STYLES_PATH).then((info) => {
      if (!closed) onVersion(`${Math.trunc(info.mtimeMs)}-${info.size}`);
    }).catch(() => undefined);
  };
  try {
    watcher = watch(directory, { persistent: false }, (_eventType, changed) => {
      if (changed && changed.toString() !== filename) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(publish, 75);
      debounceTimer.unref();
    });
  } catch {
    return () => undefined;
  }
  return () => {
    closed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher?.close();
  };
}

export function injectBuildVersion(html: string, version: string): string {
  const meta = `<meta name="terminal-ui-version" content="${escapeHtmlAttribute(version)}">`;
  return html.includes('</head>') ? html.replace('</head>', `${meta}</head>`) : `${meta}${html}`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
