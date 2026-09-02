import { execFile } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';

const RIPGREP_TIMEOUT_MS = 5_000;
const RIPGREP_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface RipgrepDiscoveryResult {
  files: string[];
  truncated: boolean;
}

/**
 * Use ripgrep only as a bounded native file enumerator. Matching remains in the
 * existing JavaScript search path so regex, context, file-size and result-limit
 * semantics stay identical to the fallback implementation.
 */
export async function discoverFilesWithRipgrep(
  root: string,
  accept: (absolutePath: string) => boolean,
  maxFiles: number,
): Promise<RipgrepDiscoveryResult | null> {
  const executable = process.env.TERMINAL_RIPGREP ?? 'rg';
  const stdout = await runRipgrep(executable, root).catch(() => null);
  if (stdout === null) return null;

  const files: string[] = [];
  let truncated = false;
  for (const candidate of stdout.split('\0')) {
    if (!candidate) continue;
    const absolutePath = resolve(root, candidate);
    const delta = relative(root, absolutePath);
    if (delta === '' || delta.startsWith('..') || isAbsolute(delta)) continue;
    if (!accept(absolutePath)) continue;
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    files.push(absolutePath);
  }
  return { files, truncated };
}

function runRipgrep(executable: string, root: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      executable,
      ['--files', '--no-ignore', '--null', '--glob', '!node_modules/**'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: RIPGREP_TIMEOUT_MS,
        maxBuffer: RIPGREP_MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error instanceof Error ? error : new Error('Ripgrep file discovery failed.', { cause: error }));
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}
