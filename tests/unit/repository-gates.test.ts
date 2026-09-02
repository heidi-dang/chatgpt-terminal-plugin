import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('repository quality gates', () => {
  it('exclude local Git worktrees from lint and Vitest discovery', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const eslintConfig = await readFile(resolve(root, 'eslint.config.js'), 'utf8');
    const gitignore = await readFile(resolve(root, '.gitignore'), 'utf8');

    expect(manifest.scripts?.test).toContain("--exclude '.worktrees/**'");
    expect(manifest.scripts?.['test:e2e']).toContain("--exclude '.worktrees/**'");
    expect(manifest.scripts?.['test:soak']).toContain("--exclude '.worktrees/**'");
    expect(eslintConfig).toContain("'.worktrees/**'");
    expect(gitignore.split(/\r?\n/)).toContain('.worktrees/');
  });
});
