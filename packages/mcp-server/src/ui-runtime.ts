import { watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TerminalUiDocument {
  html: string;
  version: string;
}

export const TERMINAL_UI_HTML_PATH = fileURLToPath(new URL('../../terminal-ui/dist/index.html', import.meta.url));

export async function readTerminalUiDocument(): Promise<TerminalUiDocument> {
  try {
    const [html, info] = await Promise.all([
      readFile(TERMINAL_UI_HTML_PATH, 'utf8'),
      stat(TERMINAL_UI_HTML_PATH),
    ]);
    const version = `${Math.trunc(info.mtimeMs)}-${info.size}`;
    return { html: injectBuildVersion(html, version), version };
  } catch (error) {
    throw new Error(`Terminal UI bundle is unavailable. Run the terminal-ui build first: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function watchTerminalUi(onVersion: (version: string) => void): () => void {
  let watcher: FSWatcher | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let closed = false;
  const directory = dirname(TERMINAL_UI_HTML_PATH);
  const filename = basename(TERMINAL_UI_HTML_PATH);

  const publishCurrentVersion = () => {
    void stat(TERMINAL_UI_HTML_PATH).then((info) => {
      if (!closed) onVersion(`${Math.trunc(info.mtimeMs)}-${info.size}`);
    }).catch(() => undefined);
  };

  try {
    watcher = watch(directory, { persistent: false }, (_eventType, changed) => {
      if (changed && changed.toString() !== filename) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(publishCurrentVersion, 75);
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
