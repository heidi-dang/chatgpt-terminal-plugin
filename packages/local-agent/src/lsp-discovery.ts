import { execFileSync } from 'node:child_process';
import type { LspServerDefinition } from './lsp-manager.js';

interface KnownLspCandidate {
  serverId: string;
  command: string;
  args: string[];
}

const KNOWN_LSP_CANDIDATES: readonly KnownLspCandidate[] = [
  { serverId: 'typescript', command: 'typescript-language-server', args: ['--stdio'] },
  { serverId: 'python', command: 'pyright-langserver', args: ['--stdio'] },
  { serverId: 'python-pylsp', command: 'pylsp', args: [] },
  { serverId: 'go', command: 'gopls', args: [] },
  { serverId: 'rust', command: 'rust-analyzer', args: [] },
  { serverId: 'clangd', command: 'clangd', args: [] },
  { serverId: 'bash', command: 'bash-language-server', args: ['start'] },
  { serverId: 'json', command: 'vscode-json-language-server', args: ['--stdio'] },
  { serverId: 'html', command: 'vscode-html-language-server', args: ['--stdio'] },
  { serverId: 'css', command: 'vscode-css-language-server', args: ['--stdio'] },
];

function isCommandAvailable(command: string): boolean {
  try {
    const lookupCmd = process.platform === 'win32' ? 'where.exe' : 'which';
    execFileSync(lookupCmd, [command], { stdio: 'ignore', timeout: 500 });
    return true;
  } catch {
    return false;
  }
}

export function discoverLspServers(
  candidates: readonly KnownLspCandidate[] = KNOWN_LSP_CANDIDATES,
): Record<string, LspServerDefinition> {
  const discovered: Record<string, LspServerDefinition> = {};
  for (const candidate of candidates) {
    if (isCommandAvailable(candidate.command)) {
      discovered[candidate.serverId] = {
        command: candidate.command,
        args: [...candidate.args],
      };
    }
  }
  return discovered;
}
