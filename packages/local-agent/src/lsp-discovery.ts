import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { LspServerDefinition } from './lsp-manager.js';

export interface KnownLspCandidate {
  serverId: string;
  command: string;
  args: string[];
}

export interface LspDiscoveryOptions {
  disabled?: boolean;
  candidates?: readonly KnownLspCandidate[];
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
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

export async function discoverLspServers(
  candidates: readonly KnownLspCandidate[] = KNOWN_LSP_CANDIDATES,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<Record<string, LspServerDefinition>> {
  const paths = pathEntries(environment.PATH);
  const extensions = executableExtensions(environment.PATHEXT, platform);
  const located = await Promise.all(candidates.map(async (candidate) => ({
    candidate,
    executable: await findExecutable(candidate.command, paths, extensions, platform),
  })));

  const discovered: Record<string, LspServerDefinition> = {};
  for (const { candidate, executable } of located) {
    if (!executable) continue;
    discovered[candidate.serverId] = { command: executable, args: [...candidate.args] };
  }
  return discovered;
}

export async function resolveLspServers(
  configured: Readonly<Record<string, LspServerDefinition>>,
  options: LspDiscoveryOptions = {},
): Promise<Record<string, LspServerDefinition>> {
  if (options.disabled) return cloneDefinitions(configured);
  const discovered = await discoverLspServers(
    options.candidates ?? KNOWN_LSP_CANDIDATES,
    options.environment ?? process.env,
    options.platform ?? process.platform,
  );
  return { ...discovered, ...cloneDefinitions(configured) };
}

async function findExecutable(
  command: string,
  paths: readonly string[],
  extensions: readonly string[],
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const candidates = isAbsolute(command) || command.includes('/') || command.includes('\\')
    ? executableNames(command, extensions, platform)
    : paths.flatMap((entry) => executableNames(join(entry, command), extensions, platform));

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next PATH/PATHEXT candidate.
    }
  }
  return undefined;
}

function pathEntries(value: string | undefined): string[] {
  return (value ?? '').split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

function executableExtensions(value: string | undefined, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [''];
  const configured = (value ?? '.COM;.EXE;.BAT;.CMD').split(';').map((entry) => entry.trim()).filter(Boolean);
  return ['', ...configured.map((entry) => entry.startsWith('.') ? entry : `.${entry}`)];
}

function executableNames(command: string, extensions: readonly string[], platform: NodeJS.Platform): string[] {
  if (platform !== 'win32' || /\.[^\\/]+$/.test(command)) return [command];
  return extensions.map((extension) => `${command}${extension}`);
}

function cloneDefinitions(definitions: Readonly<Record<string, LspServerDefinition>>): Record<string, LspServerDefinition> {
  return Object.fromEntries(Object.entries(definitions).map(([serverId, definition]) => [serverId, {
    command: definition.command,
    args: [...definition.args],
  }]));
}
