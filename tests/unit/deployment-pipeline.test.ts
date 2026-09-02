import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];
const deployScript = resolve('deploy/immutable-deploy.sh');

afterEach(async () => {
  while (cleanup.length > 0) {
    const path = cleanup.pop()!;
    await execFileAsync('chmod', ['-R', 'u+w', path]).catch(() => undefined);
    await rm(path, { recursive: true, force: true });
  }
});

describe('immutable production deployment', () => {
  it('atomically activates a verified self-contained release', async () => {
    const fixture = await createFixture();
    const revision = 'a'.repeat(40);
    const artifact = await makeArtifact(fixture.root, revision);

    await runDeploy(fixture, artifact, revision);

    expect(await readlink(join(fixture.deployRoot, 'current'))).toBe(join(fixture.deployRoot, 'releases', revision));
    expect((await readFile(join(fixture.deployRoot, 'releases', revision, 'REVISION'), 'utf8')).trim()).toBe(revision);
    expect((await readFile(join(fixture.deployRoot, 'releases', revision, 'ARTIFACT_SHA256'), 'utf8')).trim()).toBe(artifact.sha256);
    expect((await stat(join(fixture.deployRoot, 'releases', revision))).mode & 0o222).toBe(0);
    const log = await readFile(fixture.sudoLog, 'utf8');
    expect(log).toContain('systemctl restart terminal-test.service');
    expect(log).toContain('systemctl restart terminal-agent-test.service');
  });

  it('rejects an overlapping host deployment before mutating the active release', async () => {
    const fixture = await createFixture();
    const revision = 'e'.repeat(40);
    const artifact = await makeArtifact(fixture.root, revision);
    const lockPath = join(fixture.deployRoot, '.deploy.lock');
    await writeFile(lockPath, '');
    const holder = execFileAsync('flock', ['-n', lockPath, 'sleep', '1']);
    await delay(100);

    try {
      await expect(runDeploy(fixture, artifact, revision, { TERMINAL_DEPLOY_LOCK_PATH: lockPath }))
        .rejects.toMatchObject({ code: 75 });
      await expect(readlink(join(fixture.deployRoot, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await holder;
    }
  });

  it('restores the previous release when the health gate fails', async () => {
    const fixture = await createFixture();
    const previous = 'b'.repeat(40);
    const previousDir = join(fixture.deployRoot, 'releases', previous);
    await mkdir(previousDir, { recursive: true });
    await writeFile(join(previousDir, 'REVISION'), `${previous}\n`);
    await writeFile(join(previousDir, 'ARTIFACT_SHA256'), 'previous\n');
    await symlinkAbsolute(previousDir, join(fixture.deployRoot, 'current'));

    const revision = 'c'.repeat(40);
    const artifact = await makeArtifact(fixture.root, revision);
    await expect(runDeploy(fixture, artifact, revision, { FAKE_CURL_FAIL: '1' })).rejects.toMatchObject({ code: 1 });

    expect(await readlink(join(fixture.deployRoot, 'current'))).toBe(previousDir);
    const log = await readFile(fixture.sudoLog, 'utf8');
    expect(log.match(/systemctl restart terminal-test\.service/g)?.length).toBe(2);
  });

  it('removes current on a failed first deployment instead of leaving an unhealthy target', async () => {
    const fixture = await createFixture();
    const revision = 'd'.repeat(40);
    const artifact = await makeArtifact(fixture.root, revision);
    await expect(runDeploy(fixture, artifact, revision, { FAKE_CURL_FAIL: '1' })).rejects.toMatchObject({ code: 1 });

    await expect(readlink(join(fixture.deployRoot, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'terminal-deploy-test-'));
  cleanup.push(root);
  const deployRoot = join(root, 'deploy');
  const fakeBin = join(root, 'bin');
  const sudoLog = join(root, 'sudo.log');
  await mkdir(join(deployRoot, 'releases'), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeExecutable(join(fakeBin, 'sudo'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$FAKE_SUDO_LOG"\nif [[ "$1 $2 $3 $4" == "systemctl show -p ActiveState" ]]; then printf 'active\\n'; exit 0; fi\nif [[ "$1 $2 $3 $4" == "systemctl show -p SubState" ]]; then printf 'running\\n'; exit 0; fi\nif [[ "$1 $2 $3 $4" == "systemctl show -p MainPID" ]]; then printf '1234\\n'; exit 0; fi\nexit 0\n`);
  await writeExecutable(join(fakeBin, 'curl'), `#!/usr/bin/env bash\n[[ "${'${FAKE_CURL_FAIL:-0}'}" == 1 ]] && exit 1\nexit 0\n`);
  return { root, deployRoot, fakeBin, sudoLog };
}

async function makeArtifact(root: string, revision: string) {
  const stage = join(root, `stage-${revision}`);
  await mkdir(join(stage, 'packages/mcp-server/dist'), { recursive: true });
  await mkdir(join(stage, 'packages/local-agent/dist'), { recursive: true });
  await mkdir(join(stage, 'packages/local-agent/node_modules/node-pty'), { recursive: true });
  await mkdir(join(stage, 'packages/terminal-ui/dist'), { recursive: true });
  await writeFile(join(stage, 'REVISION'), `${revision}\n`);
  await writeFile(join(stage, 'packages/mcp-server/dist/index.js'), 'export {};\n');
  await writeFile(join(stage, 'packages/mcp-server/dist/cli.js'), 'export {};\n');
  await writeFile(join(stage, 'packages/local-agent/dist/cli.js'), 'export {};\n');
  await writeFile(join(stage, 'packages/local-agent/node_modules/node-pty/package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
  await writeFile(join(stage, 'packages/local-agent/node_modules/node-pty/index.js'), 'export {};\n');
  await writeFile(join(stage, 'NATIVE_RUNTIME_VERIFIED'), `node_major=${process.versions.node.split('.')[0]}\n`);
  await writeFile(join(stage, 'packages/terminal-ui/dist/index.html'), '<!doctype html><title>Terminal</title>\n');
  const archive = join(root, `${revision}.tar.gz`);
  await execFileAsync('tar', ['-C', stage, '-czf', archive, '.']);
  const { stdout } = await execFileAsync('sha256sum', [archive]);
  const sha256 = stdout.trim().split(/\s+/)[0]!;
  const checksum = `${archive}.sha256`;
  await writeFile(checksum, `${sha256}  ${archive}\n`);
  return { archive, checksum, sha256 };
}

async function runDeploy(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  artifact: Awaited<ReturnType<typeof makeArtifact>>,
  revision: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return execFileAsync('bash', [deployScript, artifact.archive, artifact.checksum, revision], {
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`,
      FAKE_SUDO_LOG: fixture.sudoLog,
      TERMINAL_DEPLOY_ROOT: fixture.deployRoot,
      TERMINAL_SERVICE_NAME: 'terminal-test.service',
      TERMINAL_AGENT_SERVICE_NAME: 'terminal-agent-test.service',
      TERMINAL_HEALTH_URL: 'https://health.invalid/health',
    },
  });
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

async function symlinkAbsolute(target: string, path: string): Promise<void> {
  const { symlink } = await import('node:fs/promises');
  await symlink(target, path);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
