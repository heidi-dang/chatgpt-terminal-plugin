import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLogger } from '../../packages/mcp-server/src/audit.js';
import {
  TrustedExtensionLoader,
  type TrustedExtensionRegistrar,
} from '../../packages/mcp-server/src/trusted-extension-loader.js';
import type { RequestIdentity } from '../../packages/mcp-server/src/service.js';

interface FakeHandle { removed: boolean; remove(): void }

function fakeRegistrar(handles: FakeHandle[]): TrustedExtensionRegistrar {
  const register = (): FakeHandle => {
    const handle: FakeHandle = {
      removed: false,
      remove() { this.removed = true; },
    };
    handles.push(handle);
    return handle;
  };
  return {
    registerTool: register,
    registerPrompt: register,
    registerResource: register,
  };
}

const owner: RequestIdentity = { userId: 'owner', clientId: 'client', executionProfile: 'owner-full' };
const developer: RequestIdentity = { userId: 'dev', clientId: 'client', executionProfile: 'developer' };

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'terminal-extension-'));
}

describe('TrustedExtensionLoader', () => {
  it('denies non-owner-full callers and records the denial', async () => {
    const root = await tempRoot();
    const auditPath = join(root, 'audit.jsonl');
    await writeFile(join(root, 'safe.mjs'), 'export default () => {}\n');
    const loader = new TrustedExtensionLoader(root, 4096, fakeRegistrar([]), new AuditLogger(auditPath));

    await expect(loader.reload(developer, 'safe')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const audit = await readFile(auditPath, 'utf8');
    expect(audit).toContain('"action":"terminal_reload_agent"');
    expect(audit).toContain('"authorization":"deny"');
  });

  it('rejects traversal-like and malformed extension identifiers', async () => {
    const root = await tempRoot();
    const loader = new TrustedExtensionLoader(root, 4096, fakeRegistrar([]), new AuditLogger());

    for (const id of ['../escape', '/tmp/escape', 'nested/name', 'UPPER', 'bad.mjs', '']) {
      await expect(loader.reload(owner, id)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
  });

  it('rejects symlink extension files even when their target is a regular module', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(join(outside, 'escape.mjs'), 'export default () => {}\n');
    await symlink(join(outside, 'escape.mjs'), join(root, 'escape.mjs'));
    const loader = new TrustedExtensionLoader(root, 4096, fakeRegistrar([]), new AuditLogger());

    await expect(loader.reload(owner, 'escape')).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
  });

  it('enforces the configured extension byte limit', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'large.mjs'), `export default () => {};\n${'x'.repeat(300)}`);
    const loader = new TrustedExtensionLoader(root, 64, fakeRegistrar([]), new AuditLogger());

    await expect(loader.reload(owner, 'large')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('loads only a unique regular js/mjs module and removes prior registrations on reload', async () => {
    const root = await tempRoot();
    const handles: FakeHandle[] = [];
    const modulePath = join(root, 'diagnostics.mjs');
    await writeFile(modulePath, [
      'export default function register(registrar) {',
      "  registrar.registerTool('diagnostics_probe', {}, () => ({}));",
      '}',
      '',
    ].join('\n'));
    const loader = new TrustedExtensionLoader(root, 4096, fakeRegistrar(handles), new AuditLogger());

    const first = await loader.reload(owner, 'diagnostics');
    expect(first).toMatchObject({ extension_id: 'diagnostics', status: 'loaded', registration_count: 1 });
    expect(handles).toHaveLength(1);
    expect(handles[0]?.removed).toBe(false);

    await writeFile(modulePath, [
      'export default function register(registrar) {',
      "  registrar.registerTool('diagnostics_probe', {}, () => ({}));",
      "  registrar.registerPrompt('diagnostics_prompt', {}, () => ({}));",
      '}',
      '',
    ].join('\n'));
    const second = await loader.reload(owner, 'diagnostics');
    expect(second.registration_count).toBe(2);
    expect(handles).toHaveLength(3);
    expect(handles[0]?.removed).toBe(true);
    expect(handles[1]?.removed).toBe(false);
    expect(handles[2]?.removed).toBe(false);
  });

  it('seals the registrar after initial extension registration completes', async () => {
    const root = await tempRoot();
    const handles: FakeHandle[] = [];
    await writeFile(join(root, 'sealed.mjs'), [
      'export default function register(registrar) {',
      '  globalThis.__terminalTrustedRegistrar = registrar;',
      "  registrar.registerTool('sealed_probe', {}, () => ({}));",
      '}',
      '',
    ].join('\n'));
    const loader = new TrustedExtensionLoader(root, 4096, fakeRegistrar(handles), new AuditLogger());

    await loader.reload(owner, 'sealed');
    const retained = (globalThis as typeof globalThis & {
      __terminalTrustedRegistrar?: TrustedExtensionRegistrar;
    }).__terminalTrustedRegistrar;
    expect(retained).toBeDefined();
    expect(() => retained?.registerTool('late_probe', {}, () => ({})))
      .toThrow(/registration window is closed/i);
    expect(handles).toHaveLength(1);
    delete (globalThis as typeof globalThis & { __terminalTrustedRegistrar?: TrustedExtensionRegistrar })
      .__terminalTrustedRegistrar;
  });

  it('serializes concurrent reloads for the same extension so no registration handles are orphaned', async () => {
    const root = await tempRoot();
    const handles: FakeHandle[] = [];
    await writeFile(join(root, 'concurrent.mjs'), [
      'export default async function register(registrar) {',
      "  registrar.registerTool('concurrent_probe', {}, () => ({}));",
      '  await new Promise((resolve) => setTimeout(resolve, 20));',
      '}',
      '',
    ].join('\n'));
    const loader = new TrustedExtensionLoader(root, 4096, fakeRegistrar(handles), new AuditLogger());

    const [first, second] = await Promise.all([
      loader.reload(owner, 'concurrent'),
      loader.reload(owner, 'concurrent'),
    ]);
    expect(first.registration_count).toBe(1);
    expect(second.registration_count).toBe(1);
    expect(handles).toHaveLength(2);
    expect(handles[0]?.removed).toBe(true);
    expect(handles[1]?.removed).toBe(false);
  });

  it('rejects ambiguous ids when both js and mjs variants exist', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'duplicate.js'), 'export default () => {}\n');
    await writeFile(join(root, 'duplicate.mjs'), 'export default () => {}\n');
    const loader = new TrustedExtensionLoader(root, 4096, fakeRegistrar([]), new AuditLogger());

    await expect(loader.reload(owner, 'duplicate')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
