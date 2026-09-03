import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  TerminalProtocolError,
  type LspStartInput,
  type SemanticApplyEditOutput,
  type SemanticEdit,
  type SemanticMemoryOutput,
  type SemanticPreviewEditOutput,
  type SemanticProjectOverviewOutput,
} from '@terminal/protocol';
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

interface StoredPreviewFile {
  absolutePath: string;
  path: string;
  expectedDigest: string;
  nextDigest: string;
  editCount: number;
  nextContent: string;
}

interface StoredPreview {
  previewId: string;
  operation: SemanticEdit['operation'];
  createdAtMs: number;
  files: StoredPreviewFile[];
  workspaceDigest: string;
  diff: string;
  truncated: boolean;
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
  previews: Map<string, StoredPreview>;
  workspaceSymbolsPrimed: boolean;
}

interface MemoryStore {
  version: 1;
  root: string;
  memories: Record<string, { content: string; updated_at: string }>;
}

interface SemanticLspManagerOptions {
  memoryDir?: string;
  previewTtlMs?: number;
}

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface TextEdit { range: LspRange; newText: string }

const MAX_SEMANTIC_RESULTS = 200;
const MAX_SEMANTIC_OUTPUT_BYTES = 64 * 1024;
const MAX_PREVIEWS_PER_WORKSPACE = 64;
const DEFAULT_PREVIEW_TTL_MS = 10 * 60_000;
const MAX_PROJECT_FILES = 5_000;
const MAX_PROJECT_PRIME_ENTRIES = 2_000;
const MAX_PROJECT_PRIME_DOCUMENTS = 32;
const SKIPPED_PROJECT_DIRS = new Set(['.git', '.worktrees', 'node_modules', 'dist', 'build', 'coverage', '.next', '.venv', 'venv', 'target', 'vendor']);
const SOURCE_LANGUAGE_IDS = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'python', 'go', 'rust', 'c', 'cpp', 'java', 'kotlin', 'shellscript']);

const CLIENT_CAPABILITIES = {
  workspace: {
    workspaceFolders: true,
    configuration: true,
    didChangeWatchedFiles: { dynamicRegistration: false },
    workspaceEdit: { documentChanges: true, resourceOperations: [] },
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
  private readonly memoryCache = new Map<string, MemoryStore>();
  private readonly previewTtlMs: number;
  private stopped = false;

  constructor(private readonly lsp: LspManager, private readonly options: SemanticLspManagerOptions = {}) {
    this.previewTtlMs = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS;
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
      previews: new Map(),
      workspaceSymbolsPrimed: false,
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
    const { document, symbols } = await this.getDocumentSymbols(workspace, filePath);
    const bounded = boundArray(symbols);
    return { semantic_id: semanticId, path: this.displayPath(workspace, document.absolutePath), symbols: bounded.items, truncated: bounded.truncated };
  }

  async findSymbols(userId: string, semanticId: string, query: string): Promise<SemanticWorkspaceSymbolsOutput> {
    const workspace = this.requireOwned(userId, semanticId);
    await this.primeWorkspaceForSymbols(workspace);
    const typescriptSymbols = await this.findTypeScriptWorkspaceSymbols(workspace, query);
    const source = typescriptSymbols ?? (await this.lsp.request(userId, {
      lsp_id: workspace.lspId,
      method: 'workspace/symbol',
      params: { query },
    })).result;
    const bounded = boundArray(source);
    return { semantic_id: semanticId, query, symbols: bounded.items, truncated: bounded.truncated };
  }

  async references(userId: string, semanticId: string, filePath: string, line: number, character: number, includeDeclaration = false): Promise<SemanticLocationsOutput> {
    return this.positionRequest(userId, semanticId, filePath, line, character, 'textDocument/references', { context: { includeDeclaration } });
  }

  async definition(userId: string, semanticId: string, filePath: string, line: number, character: number): Promise<SemanticLocationsOutput> {
    return this.positionRequest(userId, semanticId, filePath, line, character, 'textDocument/definition');
  }

  async implementations(userId: string, semanticId: string, filePath: string, line: number, character: number): Promise<SemanticLocationsOutput> {
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

  async previewEdit(userId: string, semanticId: string, edit: SemanticEdit): Promise<SemanticPreviewEditOutput> {
    const workspace = this.requireOwned(userId, semanticId);
    this.sweepPreviews(workspace);
    validatePosition(edit.line, edit.character);
    const sourceDocument = await this.syncDocument(workspace, edit.path);
    let editsByUri: Map<string, TextEdit[]>;

    if (edit.operation === 'rename') {
      const response = await this.lsp.request(userId, {
        lsp_id: workspace.lspId,
        method: 'textDocument/rename',
        params: {
          textDocument: { uri: sourceDocument.uri },
          position: { line: edit.line, character: edit.character },
          newName: edit.new_name,
        },
      });
      editsByUri = parseWorkspaceEdit(response.result);
      if (editsByUri.size === 0) throw new TerminalProtocolError('INVALID_ARGUMENT', 'Language server returned no rename edits.');
    } else {
      const symbol = await this.findEnclosingSymbol(workspace, edit.path, edit.line, edit.character);
      if (edit.operation === 'safe_delete') {
        const references = await this.lsp.request(userId, {
          lsp_id: workspace.lspId,
          method: 'textDocument/references',
          params: {
            textDocument: { uri: sourceDocument.uri },
            position: { line: edit.line, character: edit.character },
            context: { includeDeclaration: false },
          },
        });
        const count = asArray(references.result).length;
        if (count > 0) throw new TerminalProtocolError('INVALID_ARGUMENT', `Safe delete refused because references still exist for this symbol (${count}).`);
      }
      const range = requireRange(symbol.range);
      const textEdit: TextEdit = edit.operation === 'replace_symbol'
        ? { range, newText: edit.content }
        : edit.operation === 'insert_before'
          ? { range: { start: range.start, end: range.start }, newText: edit.content }
          : edit.operation === 'insert_after'
            ? { range: { start: range.end, end: range.end }, newText: edit.content }
            : { range, newText: '' };
      editsByUri = new Map([[sourceDocument.uri, [textEdit]]]);
    }

    const previewFiles: StoredPreviewFile[] = [];
    const diffParts: string[] = [];
    let diffBytes = 0;
    let truncated = false;
    for (const [uri, textEdits] of [...editsByUri.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const absolutePath = await this.resolveWorkspaceUri(workspace, uri);
      const original = await readFile(absolutePath, 'utf8');
      const nextContent = applyTextEdits(original, textEdits);
      const path = this.displayPath(workspace, absolutePath);
      const expectedDigest = digestText(original);
      const nextDigest = digestText(nextContent);
      previewFiles.push({ absolutePath, path, expectedDigest, nextDigest, editCount: textEdits.length, nextContent });
      const part = compactDiff(path, original, nextContent);
      const bytes = Buffer.byteLength(part);
      if (diffBytes + bytes <= MAX_SEMANTIC_OUTPUT_BYTES) {
        diffParts.push(part);
        diffBytes += bytes;
      } else {
        truncated = true;
      }
    }
    if (previewFiles.length === 0) throw new TerminalProtocolError('INVALID_ARGUMENT', 'Semantic edit produced no workspace files.');
    if (previewFiles.length > 64) throw new TerminalProtocolError('OUTPUT_LIMIT_REACHED', 'Semantic edit touches more than 64 files.');

    const previewId = randomUUID();
    const workspaceDigest = revisionDigest(previewFiles.map((file) => [file.path, file.expectedDigest]));
    const stored: StoredPreview = {
      previewId,
      operation: edit.operation,
      createdAtMs: Date.now(),
      files: previewFiles,
      workspaceDigest,
      diff: diffParts.join('\n'),
      truncated,
    };
    workspace.previews.set(previewId, stored);
    while (workspace.previews.size > MAX_PREVIEWS_PER_WORKSPACE) {
      const oldest = workspace.previews.keys().next().value;
      if (!oldest) break;
      workspace.previews.delete(oldest);
    }
    return previewOutput(workspace, stored);
  }

  async applyEdit(userId: string, semanticId: string, previewId: string): Promise<SemanticApplyEditOutput> {
    const workspace = this.requireOwned(userId, semanticId);
    this.sweepPreviews(workspace);
    const preview = workspace.previews.get(previewId);
    if (!preview) throw new TerminalProtocolError('SESSION_NOT_FOUND', 'Semantic edit preview was not found or expired.');

    const originals = new Map<string, { content: string; mode: number }>();
    for (const file of preview.files) {
      const content = await readFile(file.absolutePath, 'utf8');
      if (digestText(content) !== file.expectedDigest) {
        throw new TerminalProtocolError('STALE_EDIT', `Semantic edit preview is stale because ${file.path} changed after preview.`);
      }
      const info = await stat(file.absolutePath);
      originals.set(file.absolutePath, { content, mode: info.mode });
    }

    const tempPaths = new Map<string, string>();
    const committed: string[] = [];
    try {
      for (const file of preview.files) {
        const original = originals.get(file.absolutePath)!;
        const tempPath = join(dirname(file.absolutePath), `.${basename(file.absolutePath)}.semantic-${previewId}.tmp`);
        await writeFile(tempPath, file.nextContent, { encoding: 'utf8', mode: original.mode });
        await chmod(tempPath, original.mode);
        tempPaths.set(file.absolutePath, tempPath);
      }
      for (const file of preview.files) {
        await rename(tempPaths.get(file.absolutePath)!, file.absolutePath);
        committed.push(file.absolutePath);
      }
    } catch (error) {
      for (const absolutePath of committed.reverse()) {
        const original = originals.get(absolutePath);
        if (original) await writeFile(absolutePath, original.content, { encoding: 'utf8', mode: original.mode }).catch(() => undefined);
      }
      for (const tempPath of tempPaths.values()) await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }

    workspace.previews.delete(previewId);
    for (const file of preview.files) await this.syncDocument(workspace, file.absolutePath);
    return {
      semantic_id: semanticId,
      preview_id: previewId,
      applied_files: preview.files.map((file) => file.path),
      revision_digest: revisionDigest(preview.files.map((file) => [file.path, file.nextDigest])),
    };
  }

  async projectOverview(userId: string, semanticId: string): Promise<SemanticProjectOverviewOutput> {
    const workspace = this.requireOwned(userId, semanticId);
    const languageCounts = new Map<string, number>();
    const manifests: string[] = [];
    const packageManagers = new Set<string>();
    const commands: Record<string, string> = {};
    let filesSeen = 0;
    let truncated = false;
    const stack = [workspace.root];

    while (stack.length > 0 && filesSeen < MAX_PROJECT_FILES) {
      const current = stack.pop()!;
      let entries;
      try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (filesSeen >= MAX_PROJECT_FILES) { truncated = true; break; }
        if (entry.isDirectory()) {
          if (!SKIPPED_PROJECT_DIRS.has(entry.name)) stack.push(join(current, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        filesSeen += 1;
        const absolutePath = join(current, entry.name);
        const rel = relative(workspace.root, absolutePath) || entry.name;
        const language = languageNameForPath(entry.name);
        if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
        if (isManifest(entry.name)) manifests.push(rel);
        switch (entry.name) {
          case 'package.json': packageManagers.add('npm'); break;
          case 'pnpm-lock.yaml': packageManagers.add('pnpm'); break;
          case 'yarn.lock': packageManagers.add('yarn'); break;
          case 'bun.lock': case 'bun.lockb': packageManagers.add('bun'); break;
          case 'pyproject.toml': case 'requirements.txt': packageManagers.add('python'); break;
          case 'Cargo.toml': packageManagers.add('cargo'); break;
          case 'go.mod': packageManagers.add('go'); break;
        }
      }
    }

    try {
      const packageJson = JSON.parse(await readFile(join(workspace.root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
      for (const [name, value] of Object.entries(packageJson.scripts ?? {})) {
        if (typeof value === 'string' && Object.keys(commands).length < 64) commands[name.slice(0, 256)] = value.slice(0, 4096);
      }
    } catch { /* optional project metadata */ }

    const memory = await this.loadMemoryStore(workspace.root);
    return {
      semantic_id: semanticId,
      root: workspace.root,
      server_id: workspace.serverId,
      languages: [...languageCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 64).map(([language, files]) => ({ language, files })),
      package_managers: [...packageManagers].sort().slice(0, 32),
      manifests: manifests.sort().slice(0, 64),
      commands,
      memories: Object.keys(memory.memories).sort().slice(0, 256),
      truncated: truncated || manifests.length > 64 || Object.keys(memory.memories).length > 256,
    };
  }

  async readMemory(userId: string, semanticId: string, name: string): Promise<SemanticMemoryOutput> {
    const workspace = this.requireOwned(userId, semanticId);
    validateMemoryName(name);
    const store = await this.loadMemoryStore(workspace.root);
    const memory = store.memories[name];
    if (!memory) throw new TerminalProtocolError('FILE_NOT_FOUND', `Semantic project memory not found: ${name}`);
    return { semantic_id: semanticId, name, content: memory.content, updated_at: memory.updated_at };
  }

  async writeMemory(userId: string, semanticId: string, name: string, content: string): Promise<SemanticMemoryOutput> {
    const workspace = this.requireOwned(userId, semanticId);
    validateMemoryName(name);
    if (Buffer.byteLength(content) > 65_536) throw new TerminalProtocolError('FILE_TOO_LARGE', 'Semantic project memory exceeds 64 KiB.');
    const store = await this.loadMemoryStore(workspace.root);
    const updatedAt = new Date().toISOString();
    store.memories[name] = { content, updated_at: updatedAt };
    await this.persistMemoryStore(workspace.root, store);
    return { semantic_id: semanticId, name, content, updated_at: updatedAt };
  }

  close(userId: string, semanticId: string): SemanticCloseOutput {
    const workspace = this.requireOwned(userId, semanticId);
    this.workspaces.delete(semanticId);
    this.semanticByLsp.delete(workspace.lspId);
    workspace.previews.clear();
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

  private async positionRequest(userId: string, semanticId: string, filePath: string, line: number, character: number, method: string, extra: Record<string, unknown> = {}): Promise<SemanticLocationsOutput> {
    validatePosition(line, character);
    const workspace = this.requireOwned(userId, semanticId);
    const document = await this.syncDocument(workspace, filePath);
    const response = await this.lsp.request(userId, {
      lsp_id: workspace.lspId,
      method,
      params: { textDocument: { uri: document.uri }, position: { line, character }, ...extra },
    });
    const bounded = boundArray(normalizeLocations(response.result));
    return { semantic_id: semanticId, path: this.displayPath(workspace, document.absolutePath), locations: bounded.items, truncated: bounded.truncated };
  }

  private async getDocumentSymbols(workspace: SemanticWorkspace, filePath: string): Promise<{ document: OpenDocument; symbols: unknown[] }> {
    const document = await this.syncDocument(workspace, filePath);
    const response = await this.lsp.request(workspace.userId, {
      lsp_id: workspace.lspId,
      method: 'textDocument/documentSymbol',
      params: { textDocument: { uri: document.uri } },
    });
    return { document, symbols: asArray(response.result) };
  }

  private async findEnclosingSymbol(workspace: SemanticWorkspace, filePath: string, line: number, character: number): Promise<Record<string, unknown>> {
    const { symbols } = await this.getDocumentSymbols(workspace, filePath);
    const matches: Array<{ symbol: Record<string, unknown>; score: number }> = [];
    const visit = (items: unknown[]): void => {
      for (const item of items) {
        const symbol = asRecord(item);
        if (!symbol) continue;
        const range = parseRange(symbol.range ?? asRecord(symbol.location)?.range);
        if (range && rangeContains(range, { line, character })) matches.push({ symbol, score: rangeSpanScore(range) });
        if (Array.isArray(symbol.children)) visit(symbol.children);
      }
    };
    visit(symbols);
    matches.sort((a, b) => a.score - b.score);
    if (!matches[0]) throw new TerminalProtocolError('INVALID_ARGUMENT', 'No semantic symbol contains the requested position.');
    return matches[0].symbol;
  }

  private async primeWorkspaceForSymbols(workspace: SemanticWorkspace): Promise<void> {
    if (workspace.workspaceSymbolsPrimed) return;

    const preferred = preferredLanguageIdsForServer(workspace.serverId);
    if (this.supportsTypeScriptTsserverRequest(workspace)) {
      await this.primeTypeScriptProjects(workspace, preferred);
      workspace.workspaceSymbolsPrimed = true;
      return;
    }

    if (workspace.documents.size === 0) {
      const source = await this.findFirstWorkspaceSource(workspace, preferred);
      if (source) await this.syncDocument(workspace, source);
    }
    workspace.workspaceSymbolsPrimed = true;
  }

  private supportsTypeScriptTsserverRequest(workspace: SemanticWorkspace): boolean {
    const normalized = workspace.serverId.toLowerCase();
    if (!normalized.includes('typescript') && !normalized.includes('tsserver')) return false;
    const executeCommandProvider = asRecord(workspace.capabilities.executeCommandProvider);
    return Array.isArray(executeCommandProvider?.commands)
      && executeCommandProvider.commands.includes('typescript.tsserverRequest');
  }

  private async primeTypeScriptProjects(workspace: SemanticWorkspace, preferred: ReadonlySet<string>): Promise<void> {
    const queue = [workspace.root];
    const configDirectories = new Set<string>();
    const sourceFiles: string[] = [];
    let entriesSeen = 0;

    while (queue.length > 0 && entriesSeen < MAX_PROJECT_PRIME_ENTRIES) {
      const current = queue.shift()!;
      let entries;
      try {
        entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entriesSeen >= MAX_PROJECT_PRIME_ENTRIES) break;
        entriesSeen += 1;
        if (entry.isDirectory()) {
          if (!SKIPPED_PROJECT_DIRS.has(entry.name)) queue.push(join(current, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        const absolutePath = join(current, entry.name);
        if (entry.name === 'tsconfig.json' || entry.name === 'jsconfig.json') configDirectories.add(current);
        if (preferred.has(languageIdForPath(absolutePath))) sourceFiles.push(absolutePath);
      }
    }

    const representatives = selectProjectRepresentatives(workspace.root, configDirectories, sourceFiles);
    if (representatives.length === 0 && sourceFiles[0]) representatives.push(sourceFiles[0]);
    for (const source of representatives.slice(0, MAX_PROJECT_PRIME_DOCUMENTS)) {
      await this.syncDocument(workspace, source);
    }
  }

  private async findFirstWorkspaceSource(workspace: SemanticWorkspace, preferred: ReadonlySet<string>): Promise<string | undefined> {
    const queue = [workspace.root];
    let entriesSeen = 0;
    let fallback: string | undefined;
    while (queue.length > 0 && entriesSeen < MAX_PROJECT_PRIME_ENTRIES) {
      const current = queue.shift()!;
      let entries;
      try {
        entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entriesSeen >= MAX_PROJECT_PRIME_ENTRIES) break;
        entriesSeen += 1;
        if (entry.isDirectory()) {
          if (!SKIPPED_PROJECT_DIRS.has(entry.name)) queue.push(join(current, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        const absolutePath = join(current, entry.name);
        const languageId = languageIdForPath(absolutePath);
        if (preferred.has(languageId)) return absolutePath;
        if (!fallback && preferred.size === 0 && SOURCE_LANGUAGE_IDS.has(languageId)) fallback = absolutePath;
      }
    }
    return fallback;
  }

  private async findTypeScriptWorkspaceSymbols(workspace: SemanticWorkspace, query: string): Promise<unknown[] | undefined> {
    if (!this.supportsTypeScriptTsserverRequest(workspace)) return undefined;
    try {
      const response = await this.lsp.request(workspace.userId, {
        lsp_id: workspace.lspId,
        method: 'workspace/executeCommand',
        params: {
          command: 'typescript.tsserverRequest',
          arguments: ['navto', { searchValue: query, maxResultCount: MAX_SEMANTIC_RESULTS }, {}],
        },
      });
      const tsserverResponse = asRecord(response.result);
      if (tsserverResponse?.success !== true || !Array.isArray(tsserverResponse.body)) return undefined;
      const symbols: unknown[] = [];
      for (const raw of tsserverResponse.body) {
        const symbol = this.normalizeTsserverNavtoSymbol(workspace, raw);
        if (symbol) symbols.push(symbol);
      }
      return symbols;
    } catch {
      return undefined;
    }
  }

  private normalizeTsserverNavtoSymbol(workspace: SemanticWorkspace, raw: unknown): Record<string, unknown> | undefined {
    const item = asRecord(raw);
    if (!item || typeof item.name !== 'string' || typeof item.file !== 'string') return undefined;
    const absolutePath = resolve(item.file);
    if (!isWithin(workspace.root, absolutePath)) return undefined;
    const start = tsserverPosition(item.start);
    const end = tsserverPosition(item.end);
    if (!start || !end) return undefined;
    return {
      name: item.name,
      kind: tsserverSymbolKind(item.kind),
      location: { uri: pathToFileURL(absolutePath).href, range: { start, end } },
    };
  }

  private async syncDocument(workspace: SemanticWorkspace, filePath: string): Promise<OpenDocument> {
    const absolutePath = await this.resolveWorkspaceFile(workspace, filePath);
    const content = await readFile(absolutePath, 'utf8');
    const digest = digestText(content);
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
        params: { textDocument: { uri: document.uri, languageId: document.languageId, version: document.version, text: content } },
      });
      return document;
    }

    existing.version += 1;
    existing.digest = digest;
    await this.lsp.request(workspace.userId, {
      lsp_id: workspace.lspId,
      method: 'textDocument/didChange',
      notification: true,
      params: { textDocument: { uri: existing.uri, version: existing.version }, contentChanges: [{ text: content }] },
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
    if (!isWithin(workspace.root, canonical)) throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Semantic file is outside the workspace root.');
    return canonical;
  }

  private async resolveWorkspaceUri(workspace: SemanticWorkspace, uri: string): Promise<string> {
    if (!uri.startsWith('file:')) throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Semantic workspace edits may only target local file URIs.');
    return this.resolveWorkspaceFile(workspace, fileURLToPath(uri));
  }

  private requireOwned(userId: string, semanticId: string): SemanticWorkspace {
    const workspace = this.workspaces.get(semanticId);
    if (!workspace) throw new TerminalProtocolError('SESSION_NOT_FOUND', 'Semantic workspace was not found.');
    if (workspace.userId !== userId) throw new TerminalProtocolError('PERMISSION_DENIED', 'Semantic workspace is owned by another user.');
    return workspace;
  }

  private sweepPreviews(workspace: SemanticWorkspace): void {
    const cutoff = Date.now() - this.previewTtlMs;
    for (const [previewId, preview] of workspace.previews) if (preview.createdAtMs < cutoff) workspace.previews.delete(previewId);
  }

  private handleNotification(notification: LspServerNotification): void {
    if (notification.method !== 'textDocument/publishDiagnostics') return;
    const semanticId = this.semanticByLsp.get(notification.lsp_id);
    if (!semanticId) return;
    const workspace = this.workspaces.get(semanticId);
    const params = asRecord(notification.params);
    const uri = typeof params?.uri === 'string' ? params.uri : undefined;
    if (!workspace || !uri || !this.isWorkspaceFileUri(workspace, uri)) return;
    let absolutePath: string;
    try { absolutePath = fileURLToPath(uri); } catch { return; }
    const document = workspace.documents.get(absolutePath);
    if (!document || document.uri !== uri) return;
    const diagnostics = Array.isArray(params?.diagnostics) ? params.diagnostics : [];
    if (diagnostics.length === 0) {
      workspace.diagnostics.delete(uri);
      return;
    }
    const version = typeof params?.version === 'number' && Number.isInteger(params.version) ? params.version : undefined;
    workspace.diagnostics.set(uri, { diagnostics, ...(version === undefined ? {} : { version }) });
  }

  private isWorkspaceFileUri(workspace: SemanticWorkspace, uri: string): boolean {
    try { return uri.startsWith('file:') && isWithin(workspace.root, fileURLToPath(uri)); } catch { return false; }
  }

  private displayPath(workspace: SemanticWorkspace, absolutePath: string): string {
    const delta = relative(workspace.root, absolutePath);
    return delta || absolutePath;
  }

  private async loadMemoryStore(root: string): Promise<MemoryStore> {
    const key = digestText(root);
    const cached = this.memoryCache.get(key);
    if (cached) return cached;
    const path = this.memoryStorePath(root);
    if (path) {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as MemoryStore;
        if (parsed?.version === 1 && parsed.root === root && parsed.memories && typeof parsed.memories === 'object') {
          this.memoryCache.set(key, parsed);
          return parsed;
        }
      } catch { /* absent or invalid store starts empty */ }
    }
    const empty: MemoryStore = { version: 1, root, memories: {} };
    this.memoryCache.set(key, empty);
    return empty;
  }

  private async persistMemoryStore(root: string, store: MemoryStore): Promise<void> {
    const key = digestText(root);
    this.memoryCache.set(key, store);
    const path = this.memoryStorePath(root);
    if (!path) return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
  }

  private memoryStorePath(root: string): string | undefined {
    return this.options.memoryDir ? join(this.options.memoryDir, `${digestText(root)}.json`) : undefined;
  }
}

function validatePosition(line: number, character: number): void {
  if (!Number.isInteger(line) || line < 0 || !Number.isInteger(character) || character < 0) {
    throw new TerminalProtocolError('INVALID_ARGUMENT', 'Semantic line and character must be non-negative integers.');
  }
}

function validateMemoryName(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new TerminalProtocolError('INVALID_ARGUMENT', 'Semantic memory name is invalid.');
}

function previewOutput(workspace: SemanticWorkspace, preview: StoredPreview): SemanticPreviewEditOutput {
  return {
    semantic_id: workspace.semanticId,
    preview_id: preview.previewId,
    operation: preview.operation,
    workspace_digest: preview.workspaceDigest,
    files: preview.files.map((file) => ({ path: file.path, expected_digest: file.expectedDigest, next_digest: file.nextDigest, edit_count: file.editCount })),
    diff: preview.diff,
    truncated: preview.truncated,
  };
}

function parseWorkspaceEdit(value: unknown): Map<string, TextEdit[]> {
  const workspaceEdit = asRecord(value);
  if (!workspaceEdit) return new Map();
  const output = new Map<string, TextEdit[]>();
  const changes = asRecord(workspaceEdit.changes);
  if (changes) {
    for (const [uri, rawEdits] of Object.entries(changes)) output.set(uri, parseTextEdits(rawEdits));
  }
  if (Array.isArray(workspaceEdit.documentChanges)) {
    for (const rawChange of workspaceEdit.documentChanges) {
      const change = asRecord(rawChange);
      if (!change) continue;
      if ('kind' in change || 'oldUri' in change || 'newUri' in change) {
        throw new TerminalProtocolError('PERMISSION_DENIED', 'Semantic refactors do not permit language-server resource create/rename/delete operations.');
      }
      const textDocument = asRecord(change.textDocument);
      const uri = typeof textDocument?.uri === 'string' ? textDocument.uri : undefined;
      if (!uri) throw new TerminalProtocolError('INVALID_ARGUMENT', 'Language server returned an invalid text-document edit.');
      const existing = output.get(uri) ?? [];
      output.set(uri, existing.concat(parseTextEdits(change.edits)));
    }
  }
  return output;
}

function parseTextEdits(value: unknown): TextEdit[] {
  if (!Array.isArray(value)) throw new TerminalProtocolError('INVALID_ARGUMENT', 'Language server returned invalid text edits.');
  return value.map((raw): TextEdit => {
    const edit = asRecord(raw);
    const range = parseRange(edit?.range);
    const newText = typeof edit?.newText === 'string' ? edit.newText : undefined;
    if (!range || newText === undefined) throw new TerminalProtocolError('INVALID_ARGUMENT', 'Language server returned a malformed text edit.');
    return { range, newText };
  });
}

function applyTextEdits(content: string, edits: TextEdit[]): string {
  const normalized = edits.map((edit) => ({
    start: positionToOffset(content, edit.range.start),
    end: positionToOffset(content, edit.range.end),
    newText: edit.newText,
  })).sort((a, b) => b.start - a.start || b.end - a.end);
  let next = content;
  let previousStart = content.length + 1;
  for (const edit of normalized) {
    if (edit.end > previousStart) throw new TerminalProtocolError('INVALID_ARGUMENT', 'Language server returned overlapping semantic edits.');
    if (edit.start > edit.end) throw new TerminalProtocolError('INVALID_ARGUMENT', 'Language server returned an invalid semantic edit range.');
    next = next.slice(0, edit.start) + edit.newText + next.slice(edit.end);
    previousStart = edit.start;
  }
  return next;
}

function positionToOffset(content: string, position: LspPosition): number {
  validatePosition(position.line, position.character);
  let line = 0;
  let start = 0;
  while (line < position.line) {
    const newline = content.indexOf('\n', start);
    if (newline < 0) throw new TerminalProtocolError('INVALID_ARGUMENT', 'Language server edit line is outside the file.');
    start = newline + 1;
    line += 1;
  }
  const newline = content.indexOf('\n', start);
  const end = newline < 0 ? content.length : newline;
  if (position.character > end - start) throw new TerminalProtocolError('INVALID_ARGUMENT', 'Language server edit character is outside the line.');
  return start + position.character;
}

function parseRange(value: unknown): LspRange | undefined {
  const range = asRecord(value);
  const start = asRecord(range?.start);
  const end = asRecord(range?.end);
  if (!start || !end) return undefined;
  if (!Number.isInteger(start.line) || !Number.isInteger(start.character) || !Number.isInteger(end.line) || !Number.isInteger(end.character)) return undefined;
  return { start: { line: start.line as number, character: start.character as number }, end: { line: end.line as number, character: end.character as number } };
}

function requireRange(value: unknown): LspRange {
  const range = parseRange(value);
  if (!range) throw new TerminalProtocolError('INVALID_ARGUMENT', 'Semantic symbol does not provide a valid source range.');
  return range;
}

function rangeContains(range: LspRange, position: LspPosition): boolean {
  return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) <= 0;
}

function comparePosition(a: LspPosition, b: LspPosition): number {
  return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function rangeSpanScore(range: LspRange): number {
  return Math.max(0, range.end.line - range.start.line) * 10_000_000 + Math.max(0, range.end.character - range.start.character);
}

function compactDiff(path: string, before: string, after: string): string {
  if (before === after) return `--- a/${path}\n+++ b/${path}\n(no changes)\n`;
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  const contextStart = Math.max(0, prefix - 3);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const lines = [`--- a/${path}`, `+++ b/${path}`, `@@ ${contextStart + 1} @@`];
  for (let i = contextStart; i < prefix; i += 1) lines.push(` ${oldLines[i] ?? ''}`);
  for (let i = prefix; i < oldLines.length - suffix; i += 1) lines.push(`-${oldLines[i] ?? ''}`);
  for (let i = prefix; i < newLines.length - suffix; i += 1) lines.push(`+${newLines[i] ?? ''}`);
  const commonTailStart = Math.max(prefix, oldLines.length - suffix);
  for (let i = commonTailStart; i < Math.min(oldEnd, oldLines.length); i += 1) lines.push(` ${oldLines[i] ?? ''}`);
  return `${lines.join('\n')}\n`;
}

function revisionDigest(entries: Array<[string, string]>): string {
  return digestText(entries.slice().sort(([a], [b]) => a.localeCompare(b)).map(([path, digest]) => `${path}\0${digest}`).join('\n'));
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function selectProjectRepresentatives(root: string, configDirectories: ReadonlySet<string>, sourceFiles: readonly string[]): string[] {
  if (configDirectories.size === 0) return [];
  const configs = [...configDirectories].sort((a, b) => pathDepth(b, root) - pathDepth(a, root) || a.localeCompare(b));
  const representativeByConfig = new Map<string, string>();
  for (const source of sourceFiles) {
    const config = configs.find((candidate) => isPathWithinDirectory(candidate, source));
    if (config && !representativeByConfig.has(config)) representativeByConfig.set(config, source);
  }
  return configs.flatMap((config) => representativeByConfig.has(config) ? [representativeByConfig.get(config)!] : []);
}

function pathDepth(candidate: string, root: string): number {
  const delta = relative(root, candidate);
  return delta ? delta.split(sep).length : 0;
}

function isPathWithinDirectory(directory: string, candidate: string): boolean {
  const delta = relative(directory, candidate);
  return delta !== '' && !delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta);
}

function tsserverPosition(value: unknown): LspPosition | undefined {
  const position = asRecord(value);
  const line = typeof position?.line === 'number' ? position.line : Number.NaN;
  const offset = typeof position?.offset === 'number' ? position.offset : Number.NaN;
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(offset) || offset < 1) return undefined;
  return { line: line - 1, character: offset - 1 };
}

function tsserverSymbolKind(value: unknown): number {
  switch (typeof value === 'string' ? value.toLowerCase() : '') {
    case 'module': case 'external module name': return 2;
    case 'class': case 'classname': return 5;
    case 'method': case 'memberfunctionelement': return 6;
    case 'property': case 'membervariableelement': case 'getter': case 'setter': return 7;
    case 'field': return 8;
    case 'constructor': case 'constructsignatureelement': return 9;
    case 'enum': return 10;
    case 'interface': return 11;
    case 'function': case 'functionelement': case 'localfunctionelement': return 12;
    case 'variable': case 'const': case 'let': case 'varelement': case 'localvariableelement': return 13;
    case 'constant': return 14;
    case 'string': return 15;
    case 'number': return 16;
    case 'boolean': return 17;
    case 'array': return 18;
    case 'object': return 19;
    case 'key': return 20;
    case 'null': return 21;
    case 'enum member': case 'enummemberelement': return 22;
    case 'struct': return 23;
    case 'event': return 24;
    case 'operator': return 25;
    case 'type parameter': case 'typeparameter': return 26;
    default: return 13;
  }
}

function preferredLanguageIdsForServer(serverId: string): ReadonlySet<string> {
  const normalized = serverId.toLowerCase();
  if (normalized.includes('typescript') || normalized.includes('tsserver')) {
    return new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);
  }
  if (normalized.includes('python') || normalized.includes('pyright') || normalized.includes('pylsp')) return new Set(['python']);
  if (normalized.includes('gopls') || normalized === 'go') return new Set(['go']);
  if (normalized.includes('rust')) return new Set(['rust']);
  if (normalized.includes('clang') || normalized.includes('ccls')) return new Set(['c', 'cpp']);
  if (normalized.includes('java')) return new Set(['java']);
  if (normalized.includes('kotlin')) return new Set(['kotlin']);
  if (normalized.includes('bash') || normalized.includes('shell')) return new Set(['shellscript']);
  return new Set();
}

function languageIdForPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  return ({
    '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.go': 'go', '.rs': 'rust', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
    '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.sh': 'shellscript', '.bash': 'shellscript', '.json': 'json', '.jsonc': 'jsonc',
    '.html': 'html', '.css': 'css', '.scss': 'scss', '.md': 'markdown', '.yaml': 'yaml', '.yml': 'yaml',
  } as Record<string, string>)[extension] ?? 'plaintext';
}

function languageNameForPath(filePath: string): string | undefined {
  return ({
    '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
    '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.cxx': 'C++', '.hpp': 'C++',
    '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin', '.sh': 'Shell', '.bash': 'Shell', '.json': 'JSON', '.html': 'HTML', '.css': 'CSS',
    '.scss': 'SCSS', '.md': 'Markdown', '.yaml': 'YAML', '.yml': 'YAML',
  } as Record<string, string>)[extname(filePath).toLowerCase()];
}

function isManifest(name: string): boolean {
  return new Set(['package.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts']).has(name);
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
  let serializedBytes = 2;
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
