import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LspManager } from '../../packages/local-agent/src/lsp-manager.js';
import { SemanticLspManager } from '../../packages/local-agent/src/semantic-lsp.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Serena-style semantic LSP layer', () => {
  it('initializes an LSP workspace and sends the initialized notification', async () => {
    const fixture = await createFixture();
    const semantic = fixture.semantic;

    const opened = await semantic.open('user-a', { server_id: 'fake', root: fixture.root }, fixture.root);

    expect(opened).toMatchObject({
      server_id: 'fake',
      root: fixture.root,
      capabilities: { documentSymbolProvider: true, workspaceSymbolProvider: true },
    });
    await waitUntil(async () => (await readLog(fixture.logPath)).some((entry) => entry.method === 'initialized'));
    const log = await readLog(fixture.logPath);
    expect(log[0]?.method).toBe('initialize');
    expect(log.some((entry) => entry.method === 'initialized' && entry.hasId === false)).toBe(true);
  });

  it('returns document symbols after synchronizing the file with didOpen', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, 'sample.ts'), 'export function alpha() { return 1; }\n', 'utf8');
    const opened = await fixture.semantic.open('user-a', { server_id: 'fake', root: fixture.root }, fixture.root);

    const output = await fixture.semantic.documentSymbols('user-a', opened.semantic_id, 'sample.ts');

    expect(output.symbols).toEqual([
      expect.objectContaining({ name: 'alpha', kind: 12 }),
    ]);
    const log = await readLog(fixture.logPath);
    const didOpen = log.find((entry) => entry.method === 'textDocument/didOpen');
    expect(didOpen?.params).toMatchObject({
      textDocument: {
        languageId: 'typescript',
        version: 1,
        text: 'export function alpha() { return 1; }\n',
      },
    });
    expect(log.findIndex((entry) => entry.method === 'textDocument/didOpen'))
      .toBeLessThan(log.findIndex((entry) => entry.method === 'textDocument/documentSymbol'));
  });

  it('detects external file changes and sends full-text didChange before the next semantic query', async () => {
    const fixture = await createFixture();
    const filePath = join(fixture.root, 'sample.ts');
    await writeFile(filePath, 'export const value = 1;\n', 'utf8');
    const opened = await fixture.semantic.open('user-a', { server_id: 'fake', root: fixture.root }, fixture.root);
    await fixture.semantic.documentSymbols('user-a', opened.semantic_id, 'sample.ts');

    await writeFile(filePath, 'export const value = 2;\n', 'utf8');
    await fixture.semantic.documentSymbols('user-a', opened.semantic_id, 'sample.ts');

    const changes = (await readLog(fixture.logPath)).filter((entry) => entry.method === 'textDocument/didChange');
    expect(changes).toHaveLength(1);
    expect(changes[0]?.params).toMatchObject({
      textDocument: { version: 2 },
      contentChanges: [{ text: 'export const value = 2;\n' }],
    });
  });

  it('bounds semantic result payloads by serialized size, not only item count', async () => {
    const fixture = await createFixture();
    const opened = await fixture.semantic.open('user-a', { server_id: 'fake', root: fixture.root }, fixture.root);

    const output = await fixture.semantic.findSymbols('user-a', opened.semantic_id, 'huge');

    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(output.symbols))).toBeLessThanOrEqual(64 * 1024);
    expect(output.symbols.length).toBeLessThan(3);
  });

  it('wraps workspace symbol, references, definition and implementation requests as semantic operations', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, 'sample.ts'), 'export function alpha() { return 1; }\nalpha();\n', 'utf8');
    const opened = await fixture.semantic.open('user-a', { server_id: 'fake', root: fixture.root }, fixture.root);

    await expect(fixture.semantic.findSymbols('user-a', opened.semantic_id, 'alpha')).resolves.toMatchObject({
      symbols: [expect.objectContaining({ name: 'alpha' })],
    });
    await expect(fixture.semantic.references('user-a', opened.semantic_id, 'sample.ts', 0, 16, true)).resolves.toMatchObject({
      locations: [expect.objectContaining({ uri: expect.stringContaining('/sample.ts') })],
    });
    await expect(fixture.semantic.definition('user-a', opened.semantic_id, 'sample.ts', 1, 1)).resolves.toMatchObject({
      locations: [expect.objectContaining({ uri: expect.stringContaining('/sample.ts') })],
    });
    await expect(fixture.semantic.implementations('user-a', opened.semantic_id, 'sample.ts', 0, 16)).resolves.toMatchObject({
      locations: [expect.objectContaining({ uri: expect.stringContaining('/sample.ts') })],
    });
  });

  it('captures publishDiagnostics notifications and returns the latest diagnostics for a synchronized file', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, 'sample.ts'), 'export const broken = true;\n', 'utf8');
    const opened = await fixture.semantic.open('user-a', { server_id: 'fake', root: fixture.root }, fixture.root);

    await fixture.semantic.documentSymbols('user-a', opened.semantic_id, 'sample.ts');
    await waitUntil(async () => (await fixture.semantic.diagnostics('user-a', opened.semantic_id, 'sample.ts')).diagnostics.length === 1);
    const output = await fixture.semantic.diagnostics('user-a', opened.semantic_id, 'sample.ts');

    expect(output.diagnostics).toEqual([
      expect.objectContaining({ severity: 2, message: 'fixture warning' }),
    ]);
  });

  it('isolates semantic sessions by user and stops the underlying LSP process', async () => {
    const fixture = await createFixture();
    const opened = await fixture.semantic.open('user-a', { server_id: 'fake', root: fixture.root }, fixture.root);

    await expect(fixture.semantic.findSymbols('user-b', opened.semantic_id, 'alpha'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(fixture.semantic.close('user-a', opened.semantic_id)).toEqual({ semantic_id: opened.semantic_id, stopped: true });
    await expect(fixture.semantic.findSymbols('user-a', opened.semantic_id, 'alpha'))
      .rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });
});

type LogEntry = { method: string; hasId: boolean; params?: unknown };

async function createFixture(): Promise<{
  root: string;
  logPath: string;
  lsp: LspManager;
  semantic: SemanticLspManager;
}> {
  const root = await mkdtemp(join(tmpdir(), 'terminal-semantic-lsp-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const logPath = join(root, 'lsp-log.jsonl');
  const scriptPath = join(root, `${randomUUID()}.cjs`);
  await writeFile(scriptPath, fakeLspSource(), { encoding: 'utf8', mode: 0o700 });
  const lsp = new LspManager({
    servers: { fake: { command: process.execPath, args: [scriptPath, logPath] } },
    environment: testEnvironment(),
    requestTimeoutMs: 2_000,
  });
  cleanup.push(() => lsp.stopAll());
  const semantic = new SemanticLspManager(lsp);
  cleanup.push(() => semantic.stopAll());
  return { root, logPath, lsp, semantic };
}

function fakeLspSource(): string {
  return String.raw`
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
let buffer = Buffer.alloc(0);
const logPath = process.argv[2];
let rootUri = '';
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
}
function log(message) {
  fs.appendFileSync(logPath, JSON.stringify({ method: message.method, hasId: Object.hasOwn(message, 'id'), params: message.params }) + '\n');
}
function location(line = 0, character = 0) {
  return { uri: rootUri + '/sample.ts', range: { start: { line, character }, end: { line, character: character + 5 } } };
}
function handle(message) {
  log(message);
  if (message.method === 'initialize') {
    rootUri = message.params.rootUri;
    return send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {
      textDocumentSync: 1,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      referencesProvider: true,
      definitionProvider: true,
      implementationProvider: true,
      renameProvider: true
    } } });
  }
  if (message.method === 'textDocument/didOpen') {
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {
      uri: message.params.textDocument.uri,
      version: message.params.textDocument.version,
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, severity: 2, message: 'fixture warning' }]
    } });
    return;
  }
  if (message.method === 'textDocument/documentSymbol') {
    return send({ jsonrpc: '2.0', id: message.id, result: [{
      name: 'alpha', kind: 12,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 37 } },
      selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } }
    }] });
  }
  if (message.method === 'workspace/symbol') {
    if (message.params?.query === 'huge') {
      return send({ jsonrpc: '2.0', id: message.id, result: [0, 1, 2].map(i => ({ name: 'x'.repeat(40000) + i, kind: 12, location: location(i, 0) })) });
    }
    return send({ jsonrpc: '2.0', id: message.id, result: [{ name: 'alpha', kind: 12, location: location(0, 16) }] });
  }
  if (message.method === 'textDocument/references') {
    return send({ jsonrpc: '2.0', id: message.id, result: [location(1, 0)] });
  }
  if (message.method === 'textDocument/definition') {
    return send({ jsonrpc: '2.0', id: message.id, result: location(0, 16) });
  }
  if (message.method === 'textDocument/implementation') {
    return send({ jsonrpc: '2.0', id: message.id, result: [location(0, 16)] });
  }
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: null });
}
function drain() {
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString('ascii'));
    if (!match) return;
    const length = Number(match[1]);
    const start = end + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
    buffer = buffer.subarray(start + length);
    handle(message);
  }
}
process.stdin.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); drain(); });
setInterval(() => {}, 1000);
`;
}

async function readLog(path: string): Promise<LogEntry[]> {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line) as LogEntry) : [];
  } catch {
    return [];
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition.');
}

function testEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
