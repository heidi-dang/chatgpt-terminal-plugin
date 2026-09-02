import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile as writeTextFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalTerminalAgent } from '../../packages/local-agent/src/index.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('LocalTerminalAgent', () => {
  it('preserves shell state, streams output, interrupts, and closes cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-agent-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const agent = new LocalTerminalAgent({
      agentId: 'agent-test',
      displayName: 'Test computer',
      allowedWorkspaceRoots: [root],
      executionProfile: 'developer',
      shells: ['bash'],
      bufferHighWaterBytes: 1024 * 1024,
      maxEventBytes: 64 * 1024,
    });
    const started = agent.start('user-test', {
      agent_id: 'agent-test',
      cwd: root,
      shell: 'bash',
      cols: 80,
      rows: 24,
    }, 'developer');
    cleanup.push(() => {
      try { agent.close(started.session.session_id); } catch { /* already closed */ }
    });

    agent.write(started.session.session_id, "mkdir -p child && cd child && printf '__READY__\\n'\r");
    const ready = await waitForText(agent, started.session.session_id, started.cursor, '__READY__');
    expect(ready.output).toContain('__READY__');

    agent.write(started.session.session_id, 'pwd\r');
    const pwd = await waitForText(agent, started.session.session_id, ready.cursor, '/child');
    expect(normalizeTerminal(pwd.output)).toContain(`${root}/child`);
    if (process.platform === 'linux') {
      await waitUntil(() => agent.status(started.session.session_id).session.cwd === join(root, 'child'));
      expect(agent.readEvents(started.session.session_id, 0, 256 * 1024).events).toEqual(
        expect.arrayContaining([expect.objectContaining({ event_type: 'cwd.changed', data: { cwd: join(root, 'child') } })]),
      );
    }

    agent.write(started.session.session_id, 'sleep 30\r');
    const sleeping = await waitForText(agent, started.session.session_id, pwd.cursor, 'sleep 30');
    agent.interrupt(started.session.session_id);
    agent.write(started.session.session_id, "printf '__AFTER_INTERRUPT__\\n'\r");
    const afterInterrupt = await waitForText(agent, started.session.session_id, sleeping.cursor, '__AFTER_INTERRUPT__');
    expect(afterInterrupt.output).toContain('__AFTER_INTERRUPT__');

    expect(() => agent.readEvents(started.session.session_id, 0, 1)).toThrowError(/requires \d+ bytes.*max_bytes=1/i);

    const closing = agent.close(started.session.session_id);
    expect(closing.session.status).toBe('closing');
    expect(() => agent.write(started.session.session_id, 'echo nope\r')).toThrowError(
      expect.objectContaining({ code: 'SESSION_CLOSED' }),
    );
    await waitUntil(() => agent.readEvents(started.session.session_id, 0, 256 * 1024).events.at(-1)?.event_type === 'session.closed');
    expect(agent.status(started.session.session_id).session.status).toBe('closed');
    expect(agent.readEvents(started.session.session_id, 0, 256 * 1024).events.at(-1)?.event_type).toBe('session.closed');
  }, 10_000);

  it('rejects cwd outside configured workspace roots for developer profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'terminal-outside-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    cleanup.push(() => rm(outside, { recursive: true, force: true }));

    const agent = new LocalTerminalAgent({
      agentId: 'agent-test',
      allowedWorkspaceRoots: [root],
      executionProfile: 'developer',
      shells: ['bash'],
    });

    expect(() => agent.start('user-test', {
      agent_id: 'agent-test',
      cwd: outside,
      shell: 'bash',
      cols: 80,
      rows: 24,
    }, 'developer')).toThrowError(/outside the allowed workspace roots/i);
  });

  it('uses the stricter server-requested profile and rejects symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-profile-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'terminal-profile-outside-'));
    const escape = join(root, 'escape');
    await symlink(outside, escape, 'dir');
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    cleanup.push(() => rm(outside, { recursive: true, force: true }));

    const agent = new LocalTerminalAgent({
      agentId: 'agent-owner-full',
      allowedWorkspaceRoots: [root],
      executionProfile: 'owner-full',
      shells: ['bash'],
    });
    cleanup.push(() => agent.shutdown());

    const started = agent.start('user-test', {
      agent_id: 'agent-owner-full', cwd: root, shell: 'bash', cols: 80, rows: 24,
    }, 'developer');
    expect(started.session.execution_profile).toBe('developer');
    agent.close(started.session.session_id);

    expect(() => agent.start('user-test', {
      agent_id: 'agent-owner-full', cwd: escape, shell: 'bash', cols: 80, rows: 24,
    }, 'developer')).toThrowError(expect.objectContaining({ code: 'PATH_NOT_ALLOWED' }));
  });

  it('supports bounded workspace file tools and rejects path and symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-files-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'terminal-files-outside-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    cleanup.push(() => rm(outside, { recursive: true, force: true }));
    await writeTextFile(join(outside, 'secret.txt'), 'outside-secret\n', 'utf8');
    await symlink(outside, join(root, 'escape'), 'dir');
    await symlink(join(outside, 'secret.txt'), join(root, 'linked.txt'), 'file');
    await writeTextFile(join(root, 'inside.txt'), 'inside-target\n', 'utf8');
    await symlink(join(root, 'inside.txt'), join(root, 'inside-link.txt'), 'file');

    const agent = new LocalTerminalAgent({
      agentId: 'agent-files', allowedWorkspaceRoots: [root], executionProfile: 'developer', shells: ['bash'],
    });
    cleanup.push(() => agent.shutdown());
    const started = agent.start('user-test', {
      agent_id: 'agent-files', cwd: root, shell: 'bash', cols: 80, rows: 24,
    }, 'developer');

    const written = await agent.writeFile(started.session.session_id, 'nested/new.txt', 'alpha\nneedle\nomega\n', true);
    expect(written.bytes_written).toBe(Buffer.byteLength('alpha\nneedle\nomega\n'));
    expect(written.path).toBe('nested/new.txt');

    const read = await agent.readFile(started.session.session_id, 'nested/new.txt', 64 * 1024);
    expect(read).toMatchObject({ path: 'nested/new.txt', content: 'alpha\nneedle\nomega\n', truncated: false });

    const listed = await agent.listFiles(started.session.session_id, '.', 100);
    expect(listed.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'nested', type: 'directory' }),
      expect.objectContaining({ name: 'escape', type: 'symlink' }),
      expect.objectContaining({ name: 'linked.txt', type: 'symlink' }),
      expect.objectContaining({ name: 'inside-link.txt', type: 'symlink' }),
    ]));

    const searched = await agent.searchFiles(started.session.session_id, 'needle', '.', '*.txt', 20, 1);
    expect(searched.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'nested/new.txt', line: 2, text: 'needle' }),
    ]));
    expect(searched.files_searched).toBeGreaterThanOrEqual(1);

    await expect(agent.readFile(started.session.session_id, 'escape/secret.txt', 1024)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(agent.writeFile(started.session.session_id, 'escape/new.txt', 'blocked', false)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(agent.writeFile(started.session.session_id, join(outside, 'absolute.txt'), 'blocked', true)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(agent.writeFile(started.session.session_id, 'linked.txt', 'blocked', false)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });

    // Test renameFile
    const renamed = await agent.renameFile(started.session.session_id, 'nested/new.txt', 'nested/moved.txt');
    expect(renamed).toMatchObject({ from: 'nested/new.txt', to: 'nested/moved.txt' });
    const movedRead = await agent.readFile(started.session.session_id, 'nested/moved.txt', 1024);
    expect(movedRead.content).toContain('alpha');

    // Test deleteFile
    const deleted = await agent.deleteFile(started.session.session_id, 'nested/moved.txt');
    expect(deleted.path).toBe('nested/moved.txt');
    await expect(agent.readFile(started.session.session_id, 'nested/moved.txt', 1024)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });

    // Reject deleting symlinks or paths outside workspace
    await expect(agent.deleteFile(started.session.session_id, 'escape')).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(agent.renameFile(started.session.session_id, 'linked.txt', 'linked-dest.txt')).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(agent.deleteFile(started.session.session_id, 'inside-link.txt')).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(agent.renameFile(started.session.session_id, 'inside-link.txt', 'renamed-link.txt')).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    expect((await agent.readFile(started.session.session_id, 'inside.txt', 1024)).content).toBe('inside-target\n');
  });

  it('persists dynamic workspace roots and refuses removal while an active terminal uses one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-dynamic-root-a-'));
    const addedRoot = await mkdtemp(join(tmpdir(), 'terminal-dynamic-root-b-'));
    const stateDir = await mkdtemp(join(tmpdir(), 'terminal-dynamic-state-'));
    const statePath = join(stateDir, 'workspace-roots.json');
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    cleanup.push(() => rm(addedRoot, { recursive: true, force: true }));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));

    const agent = new LocalTerminalAgent({
      agentId: 'agent-dynamic-roots', allowedWorkspaceRoots: [root], executionProfile: 'developer', shells: ['bash'],
      workspaceRootsStatePath: statePath,
    });
    cleanup.push(() => agent.shutdown());
    expect(agent.getWorkspaceRoots()).toEqual([root]);
    expect(agent.addWorkspaceRoot(addedRoot)).toEqual([root, addedRoot]);

    const started = agent.start('user-test', {
      agent_id: 'agent-dynamic-roots', cwd: addedRoot, shell: 'bash', cols: 80, rows: 24,
    }, 'developer');
    expect(() => agent.removeWorkspaceRoot(addedRoot)).toThrowError(/active within it/i);
    agent.close(started.session.session_id);
    await waitUntil(() => agent.status(started.session.session_id).session.status === 'closed');
    expect(agent.removeWorkspaceRoot(addedRoot)).toEqual([root]);
    agent.shutdown();

    const reloaded = new LocalTerminalAgent({
      agentId: 'agent-dynamic-roots-reloaded', allowedWorkspaceRoots: [root, addedRoot], executionProfile: 'developer', shells: ['bash'],
      workspaceRootsStatePath: statePath,
    });
    cleanup.push(() => reloaded.shutdown());
    expect(reloaded.getWorkspaceRoots()).toEqual([root]);
    expect(() => reloaded.start('user-test', {
      agent_id: 'agent-dynamic-roots-reloaded', cwd: addedRoot, shell: 'bash', cols: 80, rows: 24,
    }, 'developer')).toThrowError(expect.objectContaining({ code: 'PATH_NOT_ALLOWED' }));
  });

  it('restores bounded session history after restart without treating the dead PTY as writable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-session-state-root-'));
    const stateDir = await mkdtemp(join(tmpdir(), 'terminal-session-state-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));

    const agent = new LocalTerminalAgent({
      agentId: 'agent-session-state', allowedWorkspaceRoots: [root], executionProfile: 'developer', shells: ['bash'],
      stateDir,
    });
    cleanup.push(() => agent.shutdown());
    const started = agent.start('user-test', {
      agent_id: 'agent-session-state', cwd: root, shell: 'bash', cols: 80, rows: 24,
      command: `printf '__PERSISTED_REPLAY__\\n'`,
    }, 'developer');
    await waitForText(agent, started.session.session_id, 0, '__PERSISTED_REPLAY__');
    await waitUntil(() => readdirSync(stateDir).some((name) => {
      if (!name.endsWith('.json')) return false;
      return readFileSync(join(stateDir, name), 'utf8').includes('__PERSISTED_REPLAY__');
    }));

    const restored = new LocalTerminalAgent({
      agentId: 'agent-session-state', allowedWorkspaceRoots: [root], executionProfile: 'developer', shells: ['bash'],
      stateDir,
    });
    cleanup.push(() => restored.shutdown());
    const restoredSnapshot = restored.listSessionSnapshots().find((snapshot) => snapshot.session.session_id === started.session.session_id);
    expect(restoredSnapshot?.session.status).toBe('closed');
    const replay = restored.readEvents(started.session.session_id, 0, 256 * 1024);
    expect(replay.events.some((event) => event.event_type === 'terminal.stdout' && typeof event.data.text === 'string' && event.data.text.includes('__PERSISTED_REPLAY__'))).toBe(true);
    expect(replay.events.at(-1)).toMatchObject({
      event_type: 'session.closed',
      actor: 'system',
      data: { reason: 'agent_restart', exit_code: null },
    });
    expect(() => restored.write(started.session.session_id, 'echo unsafe\r')).toThrowError(
      expect.objectContaining({ code: 'SESSION_CLOSED' }),
    );
  });

  it('does not expose agent control-plane secrets to spawned PTYs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-env-root-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const previous = process.env.AGENT_ENROLLMENT_TOKEN;
    process.env.AGENT_ENROLLMENT_TOKEN = 'must-not-reach-terminal';
    cleanup.push(() => {
      if (previous === undefined) delete process.env.AGENT_ENROLLMENT_TOKEN;
      else process.env.AGENT_ENROLLMENT_TOKEN = previous;
    });

    const agent = new LocalTerminalAgent({
      agentId: 'agent-env', allowedWorkspaceRoots: [root], executionProfile: 'developer', shells: ['bash'],
    });
    cleanup.push(() => agent.shutdown());
    const started = agent.start('user-test', {
      agent_id: 'agent-env', cwd: root, shell: 'bash', cols: 80, rows: 24,
      command: `printf '__CONTROL_SECRET__%s__\\n' "\${AGENT_ENROLLMENT_TOKEN:-missing}"`,
    }, 'developer');
    const output = await waitForText(agent, started.session.session_id, 0, '__CONTROL_SECRET__missing__');
    expect(output.output).not.toContain('must-not-reach-terminal');
  });
});

async function waitForText(
  agent: LocalTerminalAgent,
  sessionId: string,
  after: number,
  needle: string,
  timeoutMs = 4000,
): Promise<{ output: string; cursor: number }> {
  let cursor = after;
  let output = '';

  const consume = () => {
    const read = agent.readEvents(sessionId, cursor, 256 * 1024);
    for (const event of read.events) {
      if ((event.event_type === 'terminal.stdout' || event.event_type === 'terminal.stderr') && typeof event.data.text === 'string') {
        output += event.data.text;
      }
    }
    cursor = read.nextCursor;
    return output.includes(needle);
  };

  if (consume()) return { output, cursor };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for terminal output: ${needle}\n${normalizeTerminal(output)}`));
    }, timeoutMs);
    const unsubscribe = agent.onEvent((event) => {
      if (event.session_id !== sessionId) return;
      if (!consume()) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve({ output, cursor });
    });
  });
}

async function waitUntil(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for terminal agent condition.');
}

function normalizeTerminal(value: string): string {
  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
  return value.replace(ansiEscape, '').replace(/\r/g, '');
}
