import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TerminalProtocolError, type LspStartInput } from '@terminal/protocol';
import type { LspManager, LspServerNotification } from './lsp-manager.js';

export interface SemanticOpenOutput {
  semantic_id: string;
  lsp_id: string;
  server_id: string;
  root: string;
  capabilities: Record<string, unknown>;
}

export interface SemanticSymbolsOutput {
  semantic_id: string;
  path: string;
  symbols: unknown[];
  truncated: boolean;
}

export interface SemanticWorkspaceSymbolsOutput {
  semantic_id: string;
  query: string;
  symbols: unknown[];
  truncated: boolean;
}

export interface SemanticLocationsOutput {
  semantic_id: string;
  path: string;
  locations: unknown[];
  truncated: boolean;
}

export interface SemanticDiagnosticsOutput {
  semantic_id: string;
  path: string;
  diagnostics: unknown[];
  version?: number;
  truncated: boolean;
}

export interface SemanticCloseOutput {
  semantic_id: string;
  stopped: boolean;
}

interface OpenDocument {
  absolutePath: string;
  uri: string;
  languageId: string;
  version: number;
  digest: string;
}

interface SemanticWorkspace {
  semanticId: string;
  lspId: string;
  userId: string;
  serverId: string;
  root: string;
  rootUri: string;
  capabilities: Record<string, unknown>;
  documents: Map<string, OpenDocument>;
  diagnostics: Map<string, { diagnostics: unknown[]; version?: number }>;
}

const MAX_SEMANTIC_RESULTS = 200;
const MAX_SEMANTIC_OUTPUT_BYTES = 64 * 1024;

const CLIENT_CAPABILITIES = {
  workspace: {
    workspaceFolders: true,
    configuration: true,
    didChangeWatchedFiles: { dynamicRegistration: false },
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
    documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
    references: { dynamicRegistration: false },
    definition: { dynamicRegistration: false, linkSupport: true },
    implementation: { dynamicRegistration: false, linkSupport: true },
    rename: { dynamicRegistration: false, prepareSupport: true },
    publishDiagnostics: { relatedInformation: true, versionSupport: true },
  },
} as const;

export class SemanticLspManager {
  private readonly workspaces = new Map<string, SemanticWorkspace>();
  private readonly semanticByLsp = new Map<string, string>();
  private readonly removeNotificationListener: () => void;
  private stopped = false;

  constructor(private readonly lsp: LspManager) {
    this.removeNotificationListener = this.lsp.onNotification((notification) => this.handleNotification(notification));
  }

  async open(userId: string, input: LspStartInput, root: string): Promise<SemanticOpenOutput> {
    if (this.stopped) throw new TerminalProtocolError('AGENT_OFFLINE', 'Semantic LSP manager has been shut down.', true);
    const started = await this.lsp.start(userId, input, root);
    const semanticId = randomUUID();
    const rootUri = pathToFileURL(root).href.replace(/\/$/, '');
    const workspace: SemanticWorkspace = {
      semanticId,
      lspId: started.lsp_id,
      userId,
      serverId: started.server_id,
      root,
      rootUri,
      capabilities: {},
      documents: new Map(),
      diagnostics: new Map(),
    };
    this.workspaces.set(semanticId, workspace);
    this.semanticByLsp.set(started.lsp_id, semanticId);

    try {
      const initialized = await this.lsp.request(userId, {
        lsp_id: started.lsp_id,
        method: 'initialize',
        params: {
          processId: process.pid,
          clientInfo: { name: 'chatgpt-terminal-plugin', version: '0.1.0' },
          rootUri,
          rootPath: root,
          capabilities: CLIENT_CAPABILITIES,
          workspaceFolders: [{ uri: rootUri, name: basename(root) || root }],
          initializationOptions: {},
          trace: 'off',
        },
      });
      const result = asRecord(initialized.result);
      workspace.capabilities = asRecord(result?.capabilities) ?? {};
      await this.lsp.request(userId, {
        lsp_id: started.lsp_id,
        method: 'initialized',
        notification: true,
        params: {},
      });
      return {
        semantic_id: semanticId,
        lsp_id: started.lsp_id,
        server_id: started.server_id,
        root,
        capabilities: workspace.capabilities,
      };
    } catch (error) {
      this.workspaces.delete(semanticId);
      this.semanticByLsp.delete(started.lsp_id);
      try { this.lsp.stop(userId, started.lsp_id); } catch { /* best-effort cleanup */ }
      throw error;
    }
  }

  async documentSymbols(userId: string, semanticId: string, filePath: string): Promise<SemanticSymbolsOutput> {
    const workspace = this.requireOwned(userId, semanticId);
    const document = await this.syncDocument(workspace, filePath);
    const response = await this.lsp.request(userId, {
      lsp_id: workspace.lspId,
      method: 'textDocument/documentSymbol',
      params: { textDocument: { uri: document.uri } },
    });
    const bounded = boundArray(response.result);
    return { semantic_id: semanticId, path: this.displayPath(workspace, document.absolutePath), symbols: bounded.items, truncated: bounded.truncated };
  }

  async findSymbols(userId: string, semanticId: string, query: string): Promise<SemanticWorkspaceSymbolsOutput> {
    const workspace = this.requireOwned(userId, semanticId);
    const response = await this.lsp.request(userId, {
      lsp_id: workspace.lspId,
      method: 'workspace/symbol',
      params: { query },
    });
    const bounded = boundArray(response.result);
    return { semantic_id: semanticId, query, symbols: bounded.items, truncated: bounded.truncated };
  }

  async references(
    userId: string,
    semanticId: string,
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = false,
  ): Promise<SemanticLocationsOutput> {
    return this.positionRequest(userId, semanticId, filePath, line, character, 'textDocument/references', {
      context: { includeDeclaration },
    });
  }

  async definition(
    userId: string,
    semanticId: string,
    filePath: string,
    line: number,
    character: number,
  ): Promise<SemanticLocationsOutput> {
    return this.positionRequest(userId, semanticId, filePath, line, character, 'textDocument/definition');
  }

  async implementations(
    userId: string,
    semanticId: string,
    filePath: string,
    line: number,
    character: number,
  ): Promise<SemanticLocationsOutput> {
    return this.positionRequest(userId, semanticId, filePath, line, character, 'textDocument/implementation');
  }

  async diagnostics(userId: string, semanticId: string, filePath: string): Promise<SemanticDiagnosticsOutput> {
    const workspace = this.requireOwned(userId, semanticId);
    const document = await this.syncDocument(workspace, filePath);
    const latest = workspace.diagnostics.get(document.uri);
    const bounded = boundArray(latest?.diagnostics ?? []);
    return {
      semantic_id: semanticId,
      path: this.displayPath(workspace, document.absolutePath),
      diagnostics: bounded.items,
      ...(latest?.version === undefined ? {} : { version: latest.version }),
      truncated: bounded.truncated,
    };
  }

  close(userId: string, semanticId: string): SemanticCloseOutput {
    const workspace = this.requireOwned(userId, semanticId);
    this.workspaces.delete(semanticId);
    this.semanticByLsp.delete(workspace.lspId);
    this.lsp.stop(userId, workspace.lspId);
    return { semantic_id: semanticId, stopped: true };
  }

  stopAll(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.removeNotificationListener();
    for (const workspace of [...this.workspaces.values()]) {
      try { this.lsp.stop(workspace.userId, workspace.lspId); } catch { /* underlying LSP may already be gone */ }
    }
    this.workspaces.clear();
    this.semanticByLsp.clear();
  }

  private async positionRequest(
    userId: string,
    semanticId: string,
    filePath: string,
    line: number,
    character: number,
    method: string,
    extra: Record<string, unknown> = {},
  ): Promise<SemanticLocationsOutput> {
    if (!Number.isInteger(line) || line < 0 || !Number.isInteger(character) || character < 0) {
      throw new TerminalProtocolError('INVALID_ARGUMENT', 'Semantic line and character must be non-negative integers.');
    }
    const workspace = this.requireOwned(userId, semanticId);
    const document = await this.syncDocument(workspace, filePath);
    const response = await this.lsp.request(userId, {
      lsp_id: workspace.lspId,
      method,
      params: {
        textDocument: { uri: document.uri },
        position: { line, character },
        ...extra,
      },
    });
    const bounded = boundArray(normalizeLocations(response.result));
    return {
      semantic_id: semanticId,
      path: this.displayPath(workspace, document.absolutePath),
      locations: bounded.items,
      truncated: bounded.truncated,
    };
  }

  private async syncDocument(workspace: SemanticWorkspace, filePath: string): Promise<OpenDocument> {
    const absolutePath = await this.resolveWorkspaceFile(workspace, filePath);
    const content = await readFile(absolutePath, 'utf8');
    const digest = createHash('sha256').update(content).digest('hex');
    const existing = workspace.documents.get(absolutePath);
    if (existing?.digest === digest) return existing;

    if (!existing) {
      const document: OpenDocument = {
        absolutePath,
        uri: pathToFileURL(absolutePath).href,
        languageId: languageIdForPath(absolutePath),
        version: 1,
        digest,
      };
      workspace.documents.set(absolutePath, document);
      await this.lsp.request(workspace.userId, {
        lsp_id: workspace.lspId,
        method: 'textDocument/didOpen',
        notification: true,
        params: {
          textDocument: {
            uri: document.uri,
            languageId: document.languageId,
            version: document.version,
            text: content,
          },
        },
      });
      return document;
    }

    existing.version += 1;
    existing.digest = digest;
    await this.lsp.request(workspace.userId, {
      lsp_id: workspace.lspId,
      method: 'textDocument/didChange',
      notification: true,
      params: {
        textDocument: { uri: existing.uri, version: existing.version },
        contentChanges: [{ text: content }],
      },
    });
    return existing;
  }

  private async resolveWorkspaceFile(workspace: SemanticWorkspace, filePath: string): Promise<string> {
    const requested = isAbsolute(filePath) ? filePath : resolve(workspace.root, filePath);
    let canonical: string;
    try {
      canonical = await realpath(requested);
      const info = await stat(canonical);
      if (!info.isFile()) throw new TerminalProtocolError('INVALID_ARGUMENT', 'Semantic path is not a regular file.');
    } catch (error) {
      if (error instanceof TerminalProtocolError) throw error;
      throw new TerminalProtocolError('FILE_NOT_FOUND', `Semantic file not found: ${filePath}`);
    }
    if (!isWithin(workspace.root, canonical)) {
      throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Semantic file is outside the workspace root.');
    }
    return canonical;
  }

  private requireOwned(userId: string, semanticId: string): SemanticWorkspace {
    const workspace = this.workspaces.get(semanticId);
    if (!workspace) throw new TerminalProtocolError('SESSION_NOT_FOUND', 'Semantic workspace was not found.');
    if (workspace.userId !== userId) throw new TerminalProtocolError('PERMISSION_DENIED', 'Semantic workspace is owned by another user.');
    return workspace;
  }

  private handleNotification(notification: LspServerNotification): void {
    if (notification.method !== 'textDocument/publishDiagnostics') return;
    const semanticId = this.semanticByLsp.get(notification.lsp_id);
    if (!semanticId) return;
    const workspace = this.workspaces.get(semanticId);
    const params = asRecord(notification.params);
    const uri = typeof params?.uri === 'string' ? params.uri : undefined;
    if (!workspace || !uri || !this.isWorkspaceFileUri(workspace, uri)) return;
    const diagnostics = Array.isArray(params?.diagnostics) ? params.diagnostics : [];
    const version = typeof params?.version === 'number' && Number.isInteger(params.version) ? params.version : undefined;
    workspace.diagnostics.set(uri, { diagnostics, ...(version === undefined ? {} : { version }) });
  }

  private isWorkspaceFileUri(workspace: SemanticWorkspace, uri: string): boolean {
    try {
      if (!uri.startsWith('file:')) return false;
      return isWithin(workspace.root, fileURLToPath(uri));
    } catch {
      return false;
    }
  }

  private displayPath(workspace: SemanticWorkspace, absolutePath: string): string {
    const delta = relative(workspace.root, absolutePath);
    return delta || absolutePath;
  }
}

function languageIdForPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  return ({
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.c': 'c',
    '.h': 'c',
    '.cc': 'cpp',
    '.cpp': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.java': 'java',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.sh': 'shellscript',
    '.bash': 'shellscript',
    '.json': 'json',
    '.jsonc': 'jsonc',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.md': 'markdown',
    '.yaml': 'yaml',
    '.yml': 'yaml',
  } as Record<string, string>)[extension] ?? 'plaintext';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function normalizeLocations(value: unknown): unknown[] {
  return asArray(value);
}

function boundArray(value: unknown): { items: unknown[]; truncated: boolean } {
  const source = asArray(value);
  const items: unknown[] = [];
  let serializedBytes = 2; // JSON array brackets.
  for (const item of source) {
    if (items.length >= MAX_SEMANTIC_RESULTS) break;
    const encoded = JSON.stringify(item);
    const itemBytes = Buffer.byteLength(encoded) + (items.length === 0 ? 0 : 1);
    if (serializedBytes + itemBytes > MAX_SEMANTIC_OUTPUT_BYTES) break;
    items.push(item);
    serializedBytes += itemBytes;
  }
  return { items, truncated: items.length < source.length };
}

function isWithin(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta));
}
