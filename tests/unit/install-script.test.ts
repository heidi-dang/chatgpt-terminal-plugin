import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const installer = new URL('../../install.sh', import.meta.url);

function runInstaller(args: string[]) {
  return spawnSync('bash', [installer.pathname, ...args], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

describe('install.sh', () => {
  it('is executable and uses strict bash mode', async () => {
    await expect(access(installer, constants.X_OK)).resolves.toBeUndefined();
    const source = await readFile(installer, 'utf8');
    expect(source).toMatch(/^#!\/usr\/bin\/env bash/m);
    expect(source).toContain('set -Eeuo pipefail');
  });

  it('documents the supported one-command install modes', () => {
    const result = runInstaller(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: ./install.sh');
    expect(result.stdout).toContain('--dev');
    expect(result.stdout).toContain('--verify');
    expect(result.stdout).toContain('--skip-tests');
  });

  it('rejects unknown options without mutating the repository', () => {
    const result = runInstaller(['--definitely-invalid']);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Unknown option');
  });
});
