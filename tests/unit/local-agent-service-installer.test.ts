import { execFile } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const sourceRoot = resolve('.');
const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) await rm(cleanup.pop()!, { recursive: true, force: true });
});

describe('local-agent service installer rollback', () => {
  it('restores the previous release pointer and unit when the new service fails to start', async () => {
    const fixture = await createFixture();
    const previous = join(fixture.root, 'previous-release');
    await mkdir(previous, { recursive: true });
    await mkdir(join(fixture.home, '.local/share/chatgpt-terminal-plugin'), { recursive: true });
    await symlink(previous, join(fixture.home, '.local/share/chatgpt-terminal-plugin/current'));
    const unitPath = join(fixture.home, '.config/systemd/user/chatgpt-terminal-agent.service');
    await mkdir(join(fixture.home, '.config/systemd/user'), { recursive: true });
    await writeFile(unitPath, 'OLD UNIT\n');

    await expect(runInstaller(fixture, { FAKE_RESTART_FAIL: '1', FAKE_PREVIOUS_ENABLED: '1' })).rejects.toBeTruthy();

    expect(await readlink(join(fixture.home, '.local/share/chatgpt-terminal-plugin/current'))).toBe(previous);
    expect(await readFile(unitPath, 'utf8')).toBe('OLD UNIT\n');
  });

  it('removes first-install state when the service cannot start', async () => {
    const fixture = await createFixture();
    const current = join(fixture.home, '.local/share/chatgpt-terminal-plugin/current');
    const unitPath = join(fixture.home, '.config/systemd/user/chatgpt-terminal-agent.service');

    await expect(runInstaller(fixture, { FAKE_RESTART_FAIL: '1' })).rejects.toBeTruthy();

    await expect(access(current)).rejects.toBeTruthy();
    await expect(access(unitPath)).rejects.toBeTruthy();
    expect(await readFile(fixture.systemctlLog, 'utf8')).toContain('--user disable --now chatgpt-terminal-agent.service');
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'terminal-agent-installer-'));
  cleanup.push(root);
  const checkout = join(root, 'checkout');
  const home = join(root, 'home');
  const fakeBin = join(root, 'bin');
  const systemctlLog = join(root, 'systemctl.log');
  await mkdir(join(checkout, 'scripts'), { recursive: true });
  await mkdir(join(checkout, 'deploy/systemd'), { recursive: true });
  await mkdir(join(checkout, 'packages/local-agent/dist'), { recursive: true });
  await mkdir(join(home, '.config/chatgpt-terminal-plugin'), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await cp(join(sourceRoot, 'scripts/install-local-agent-service.sh'), join(checkout, 'scripts/install-local-agent-service.sh'));
  await cp(join(sourceRoot, 'deploy/systemd/chatgpt-terminal-agent.service.example'), join(checkout, 'deploy/systemd/chatgpt-terminal-agent.service.example'));
  await writeFile(join(checkout, 'packages/local-agent/dist/cli.js'), 'export {};\n');
  await writeFile(join(home, '.config/chatgpt-terminal-plugin/agent.env'), 'AGENT_GATEWAY_URL=wss://example.invalid/agent\n');
  const fakeSystemctl = join(fakeBin, 'systemctl');
  await writeFile(fakeSystemctl, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$FAKE_SYSTEMCTL_LOG"\nif [[ "$*" == "--user is-enabled --quiet chatgpt-terminal-agent.service" ]]; then [[ "${'$'}{FAKE_PREVIOUS_ENABLED:-0}" == 1 ]]; exit; fi\nif [[ "${'$'}{FAKE_RESTART_FAIL:-0}" == 1 && "$*" == "--user restart chatgpt-terminal-agent.service" ]]; then exit 1; fi\nexit 0\n`);
  await chmod(fakeSystemctl, 0o755);
  return { root, checkout, home, fakeBin, systemctlLog };
}

async function runInstaller(fixture: Awaited<ReturnType<typeof createFixture>>, extraEnv: NodeJS.ProcessEnv = {}) {
  return execFileAsync('bash', [join(fixture.checkout, 'scripts/install-local-agent-service.sh')], {
    env: {
      ...process.env,
      ...extraEnv,
      HOME: fixture.home,
      PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`,
      FAKE_SYSTEMCTL_LOG: fixture.systemctlLog,
    },
  });
}
