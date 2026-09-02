import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { terminalExecuteCodeBlockToolSchema, terminalLspRequestSchema } from '../../packages/protocol/src/index.js';
import { CodeBlockExecutor } from '../../packages/local-agent/src/code-block-executor.js';
import { cleanEnvironment, LocalTerminalAgent } from '../../packages/local-agent/src/index.js';
import { LspManager } from '../../packages/local-agent/src/lsp-manager.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('bounded code execution', () => {
  it('rejects unsupported runtimes instead of falling back to a shell', () => {
    const parsed = terminalExecuteCodeBlockToolSchema.safeParse({
      agent_id: 'agent-a', runtime: 'ruby', code: 'puts :unsafe',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a caller-supplied execution UUID so a running call can be cancelled explicitly', () => {
    const executionId = randomUUID();
    const parsed = terminalExecuteCodeBlockToolSchema.parse({
      agent_id: 'agent-a', execution_id: executionId, runtime: 'node', code: 'setTimeout(() => {}, 1000)',
    });
    expect(parsed.execution_id).toBe(executionId);
  });

  it('confines owner-full code execution to workspace roots and strips control-plane secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-code-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'terminal-code-outside-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    cleanup.push(() => rm(outside, { recursive: true, force: true }));

    const previous = process.env.AGENT_ENROLLMENT_TOKEN;
    process.env.AGENT_ENROLLMENT_TOKEN = 'must-not-leak';
    cleanup.push(() => {
      if (previous === undefined) delete process.env.AGENT_ENROLLMENT_TOKEN;
      else process.env.AGENT_ENROLLMENT_TOKEN = previous;
    });

    const agent = new LocalTerminalAgent({
      agentId: 'agent-code', allowedWorkspaceRoots: [root], executionProfile: 'owner-full', shells: ['bash'],
    });
    cleanup.push(() => agent.shutdown());

    const output = await agent.executeCode('user-a', {
      execution_id: randomUUID(), runtime: 'bash', cwd: root,
      code: `printf '%s' "\${AGENT_ENROLLMENT_TOKEN:-missing}"`, timeout_ms: 2_000,
    }, 'owner-full');
    expect(output.stdout).toBe('missing');
    expect(output.exit_code).toBe(0);

    await expect(agent.executeCode('user-a', {
      execution_id: randomUUID(), runtime: 'bash', cwd: outside, code: 'pwd', timeout_ms: 2_000,
    }, 'owner-full')).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
  });

  it('denies process execution when either side reduces the effective profile to read-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-code-profile-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const agent = new LocalTerminalAgent({
      agentId: 'agent-code', allowedWorkspaceRoots: [root], executionProfile: 'owner-full', shells: ['bash'],
    });
    cleanup.push(() => agent.shutdown());

    await expect(agent.executeCode('user-a', {
      execution_id: randomUUID(), runtime: 'node', cwd: root, code: `console.log('blocked')`,
    }, 'read-only')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('uses an administrator-configured TypeScript-capable Node runtime instead of process.execPath', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-code-typescript-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const wrapper = join(root, 'typescript-node');
    const marker = join(root, 'typescript-node-used.txt');
    await writeFile(wrapper, `#!/bin/sh
printf '%s' used > "${marker}"
exec "${process.execPath}" "$@"
`, { mode: 0o700 });
    const executor = new CodeBlockExecutor({
      environment: { ...cleanEnvironment(), TERMINAL_TYPESCRIPT_NODE: wrapper },
    });
    cleanup.push(() => executor.shutdown());

    const output = await executor.execute('user-a', {
      execution_id: randomUUID(), runtime: 'typescript',
      code: `const value: number = 42; console.log(value)`, timeout_ms: 2_000,
    }, root);

    expect(output.exit_code).toBe(0);
    expect(output.stdout.trim()).toBe('42');
    await expect(access(marker)).resolves.toBeUndefined();
  });

  it('passes stdin content to executing code processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-code-stdin-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executor = new CodeBlockExecutor({ environment: cleanEnvironment() });
    cleanup.push(() => executor.shutdown());

    const output = await executor.execute('user-a', {
      execution_id: randomUUID(),
      runtime: 'node',
      code: 'import { readFileSync } from "node:fs"; const input = readFileSync(0, "utf8"); console.log("ECHO:" + input.trim());',
      stdin: 'hello-from-stdin',
      timeout_ms: 2_000,
    }, root);

    expect(output.exit_code).toBe(0);
    expect(output.stdout.trim()).toBe('ECHO:hello-from-stdin');
  });

  it('does not allocate a writable stdin pipe when stdin is omitted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-code-no-stdin-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executor = new CodeBlockExecutor({ environment: cleanEnvironment() });
    cleanup.push(() => executor.shutdown());

    const output = await executor.execute('user-a', {
      execution_id: randomUUID(), runtime: 'node',
      code: 'import { readFileSync } from "node:fs"; console.log(JSON.stringify(readFileSync(0, "utf8")))',
      timeout_ms: 2_000,
    }, root);

    expect(output.exit_code).toBe(0);
    expect(output.stdout.trim()).toBe('""');
  });

  it('enforces the stdin payload bound at the protocol boundary', () => {
    const parsed = terminalExecuteCodeBlockToolSchema.safeParse({
      agent_id: 'agent-a', runtime: 'node', code: 'process.exit(0)', stdin: 'x'.repeat(262_145),
    });
    expect(parsed.success).toBe(false);
  });

  it('streams stdout and stderr chunks in real time via onChunk callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-code-stream-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executor = new CodeBlockExecutor({ environment: cleanEnvironment() });
    cleanup.push(() => executor.shutdown());

    const chunks: Array<{ stream: string; text: string }> = [];
    const output = await executor.execute('user-a', {
      execution_id: randomUUID(),
      runtime: 'node',
      code: 'console.log("out1"); console.error("err1"); console.log("out2");',
      timeout_ms: 2_000,
    }, root, (stream, chunk) => {
      chunks.push({ stream, text: chunk });
    });

    expect(output.exit_code).toBe(0);
    expect(chunks.some(c => c.stream === 'stdout' && c.text.includes('out1'))).toBe(true);
    expect(chunks.some(c => c.stream === 'stderr' && c.text.includes('err1'))).toBe(true);
    expect(chunks.some(c => c.stream === 'stdout' && c.text.includes('out2'))).toBe(true);
  });

  it('enforces execution timeouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-code-timeout-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executor = new CodeBlockExecutor({ environment: cleanEnvironment(), killGraceMs: 20 });
    cleanup.push(() => executor.shutdown());

    const startedAt = Date.now();
    const output = await executor.execute('user-a', {
      execution_id: randomUUID(), runtime: 'node', code: 'setTimeout(() => {}, 30_000)', timeout_ms: 80,
    }, root);
    expect(output.timed_out).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('terminates execution when output limits are exceeded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-code-output-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executor = new CodeBlockExecutor({
      environment: cleanEnvironment(), maxStdoutBytes: 64, maxStderrBytes: 64, maxCombinedOutputBytes: 96, killGraceMs: 20,
    });
    cleanup.push(() => executor.shutdown());

    await expect(executor.execute('user-a', {
      execution_id: randomUUID(), runtime: 'node', code: `process.stdout.write('x'.repeat(4096))`, timeout_ms: 2_000,
    }, root)).rejects.toMatchObject({ code: 'OUTPUT_LIMIT_REACHED' });
  });

  it('reports an explicit cancellation instead of a successful-looking null exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-code-cancel-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executor = new CodeBlockExecutor({ environment: cleanEnvironment(), killGraceMs: 20 });
    cleanup.push(() => executor.shutdown());
    const executionId = randomUUID();

    const running = executor.execute('user-a', {
      execution_id: executionId, runtime: 'node', code: 'setTimeout(() => {}, 30_000)', timeout_ms: 30_000,
    }, root);
    await delay(60);
    expect(executor.cancel('user-a', executionId)).toEqual({ execution_id: executionId, cancelled: true });
    await expect(running).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });
});

describe('bounded LSP management', () => {
  it('accepts explicit LSP notification intent in the public tool schema', () => {
    expect(terminalLspRequestSchema.parse({
      agent_id: 'agent-a', lsp_id: randomUUID(), method: 'custom/notify', notification: true, params: { value: 7 },
    })).toMatchObject({ method: 'custom/notify', notification: true });
  });

  it('rejects arbitrary or unconfigured LSP server IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-lsp-root-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const manager = new LspManager({ servers: {}, environment: cleanEnvironment() });
    cleanup.push(() => manager.stopAll());

    await expect(manager.start('user-a', { server_id: 'shell', root }, root))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('returns a typed spawn failure for a configured missing executable without crashing Node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-lsp-missing-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const manager = new LspManager({
      servers: { broken: { command: '/definitely/not/a/real/lsp-binary', args: [] } }, environment: cleanEnvironment(),
    });
    cleanup.push(() => manager.stopAll());

    await expect(manager.start('user-a', { server_id: 'broken', root }, root))
      .rejects.toMatchObject({ code: 'PTY_CREATE_FAILED' });
  });

  it('correlates bounded JSON-RPC responses and enforces user ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-lsp-echo-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const script = await writeLspScript(root, `
      let buffer = Buffer.alloc(0);
      process.stdin.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); drain(); });
      function send(msg) { const body = JSON.stringify(msg); process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body); }
      function drain() {
        for (;;) {
          const end = buffer.indexOf('\\r\\n\\r\\n'); if (end < 0) return;
          const header = buffer.subarray(0, end).toString('ascii');
          const m = /Content-Length:\\s*(\\d+)/i.exec(header); if (!m) return;
          const len = Number(m[1]); const start = end + 4; if (buffer.length < start + len) return;
          const msg = JSON.parse(buffer.subarray(start, start + len).toString('utf8')); buffer = buffer.subarray(start + len);
          if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: { method: msg.method, value: msg.params?.value } });
        }
      }
    `);
    const manager = new LspManager({ servers: { echo: { command: process.execPath, args: [script] } }, environment: cleanEnvironment() });
    cleanup.push(() => manager.stopAll());
    const started = await manager.start('user-a', { server_id: 'echo', root }, root);

    expect(() => manager.request('user-b', { lsp_id: started.lsp_id, method: 'test', params: {} }))
      .toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(() => manager.stop('user-b', started.lsp_id))
      .toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    await expect(manager.request('user-a', { lsp_id: started.lsp_id, method: 'example/echo', params: { value: 42 } }))
      .resolves.toEqual({ lsp_id: started.lsp_id, result: { method: 'example/echo', value: 42 } });
    expect(manager.stop('user-a', started.lsp_id)).toEqual({ lsp_id: started.lsp_id, stopped: true });
  });

  it('sends standard and explicit LSP notifications without JSON-RPC ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-lsp-notify-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const marker = join(root, 'notifications.txt');
    const script = await writeLspScript(root, `
      const fs = require('node:fs'); let buffer = Buffer.alloc(0);
      process.stdin.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); drain(); });
      function drain() {
        for (;;) {
          const end = buffer.indexOf('\\r\\n\\r\\n'); if (end < 0) return;
          const m = /Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0,end).toString('ascii')); if (!m) return;
          const len = Number(m[1]); const start = end + 4; if (buffer.length < start + len) return;
          const msg = JSON.parse(buffer.subarray(start,start+len).toString('utf8')); buffer = buffer.subarray(start+len);
          fs.appendFileSync(process.argv[2], JSON.stringify({ method: msg.method, hasId: Object.hasOwn(msg, 'id') }) + '\\n');
        }
      }
      setInterval(() => {}, 1000);
    `);
    const manager = new LspManager({ servers: { notify: { command: process.execPath, args: [script, marker] } }, environment: cleanEnvironment() });
    cleanup.push(() => manager.stopAll());
    const started = await manager.start('user-a', { server_id: 'notify', root }, root);

    await expect(manager.request('user-a', { lsp_id: started.lsp_id, method: 'initialized', params: {} }))
      .resolves.toEqual({ lsp_id: started.lsp_id });
    await expect(manager.request('user-a', { lsp_id: started.lsp_id, method: 'custom/notify', notification: true, params: { value: 1 } }))
      .resolves.toEqual({ lsp_id: started.lsp_id });
    await waitUntil(async () => {
      try {
        const text = await (await import('node:fs/promises')).readFile(marker, 'utf8');
        return text.trim().split('\n').length >= 2;
      } catch { return false; }
    });
    const text = await (await import('node:fs/promises')).readFile(marker, 'utf8');
    expect(text.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { method: 'initialized', hasId: false },
      { method: 'custom/notify', hasId: false },
    ]);
  });

  it('times out pending requests and sends LSP $/cancelRequest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-lsp-timeout-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const marker = join(root, 'cancelled.txt');
    const script = await writeLspScript(root, `
      const fs = require('node:fs'); let buffer = Buffer.alloc(0);
      process.stdin.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); drain(); });
      function drain() {
        for (;;) {
          const end = buffer.indexOf('\\r\\n\\r\\n'); if (end < 0) return;
          const m = /Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0,end).toString('ascii')); if (!m) return;
          const len = Number(m[1]); const start = end + 4; if (buffer.length < start + len) return;
          const msg = JSON.parse(buffer.subarray(start,start+len).toString('utf8')); buffer = buffer.subarray(start+len);
          if (msg.method === '$/cancelRequest') fs.writeFileSync(process.argv[2], String(msg.params?.id));
        }
      }
      setInterval(() => {}, 1000);
    `);
    const manager = new LspManager({
      servers: { slow: { command: process.execPath, args: [script, marker] } }, environment: cleanEnvironment(), requestTimeoutMs: 80,
    });
    cleanup.push(() => manager.stopAll());
    const started = await manager.start('user-a', { server_id: 'slow', root }, root);

    await expect(manager.request('user-a', { lsp_id: started.lsp_id, method: 'slow/request', params: {} }))
      .rejects.toMatchObject({ code: 'AGENT_TIMEOUT' });
    await waitUntil(async () => { try { await access(marker); return true; } catch { return false; } });
  });

  it('rejects malformed Content-Length framing and clears pending requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-lsp-frame-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const script = await writeLspScript(root, `process.stdin.once('data', () => process.stdout.write('Content-Length: nope\\r\\n\\r\\n{}')); setInterval(() => {}, 1000);`);
    const manager = new LspManager({ servers: { bad: { command: process.execPath, args: [script] } }, environment: cleanEnvironment(), requestTimeoutMs: 1_000 });
    cleanup.push(() => manager.stopAll());
    const started = await manager.start('user-a', { server_id: 'bad', root }, root);

    await expect(manager.request('user-a', { lsp_id: started.lsp_id, method: 'bad/frame', params: {} }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(() => manager.request('user-a', { lsp_id: started.lsp_id, method: 'after/failure', params: {} }))
      .toThrowError(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }));
  });

  it('enforces a maximum concurrent LSP process count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-lsp-limit-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const script = await writeLspScript(root, `setInterval(() => {}, 1000);`);
    const manager = new LspManager({
      servers: { idle: { command: process.execPath, args: [script] } }, environment: cleanEnvironment(), maxProcesses: 1,
    });
    cleanup.push(() => manager.stopAll());
    const first = await manager.start('user-a', { server_id: 'idle', root }, root);
    await expect(manager.start('user-a', { server_id: 'idle', root }, root))
      .rejects.toMatchObject({ code: 'SESSION_LIMIT_REACHED' });
    manager.stop('user-a', first.lsp_id);
  });
});

async function writeLspScript(root: string, source: string): Promise<string> {
  const path = join(root, `${randomUUID()}.cjs`);
  await writeFile(path, source, { encoding: 'utf8', mode: 0o700 });
  return path;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for condition.');
}
