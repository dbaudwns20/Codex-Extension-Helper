import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('packaged runtime', () => {
  it('loads with vscode as its only external module', async () => {
    const temporaryPath = await mkdtemp(path.join(tmpdir(), 'codex-inline-runtime-'));

    try {
      const runtimePath = path.join(temporaryPath, 'out', 'src');
      const vscodeStubPath = path.join(temporaryPath, 'node_modules', 'vscode');
      await mkdir(runtimePath, { recursive: true });
      await copyFile(path.resolve('out/src/extension.js'), path.join(runtimePath, 'extension.js'));
      await mkdir(vscodeStubPath, { recursive: true });
      await writeFile(
        path.join(vscodeStubPath, 'package.json'),
        JSON.stringify({ name: 'vscode', version: '0.0.0', main: 'index.js' }),
        'utf8',
      );
      await writeFile(path.join(vscodeStubPath, 'index.js'), 'module.exports = {};\n', 'utf8');

      const entryPath = path.join(runtimePath, 'extension.js');
      const result = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', entryPath], {
        cwd: temporaryPath,
        encoding: 'utf8',
      });

      expect(result.status, result.stderr).toBe(0);
    } finally {
      await rm(temporaryPath, { recursive: true, force: true });
    }
  });

  it('lists the bundled entry as the only packaged runtime JavaScript', () => {
    const executable = path.resolve(
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'vsce.cmd' : 'vsce',
    );
    const result = spawnSync(executable, ['ls', '--no-dependencies'], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(
      result.stdout
        .split(/\r?\n/u)
        .filter((entry) => entry.startsWith('out/src/') && entry.endsWith('.js')),
    ).toEqual(['out/src/extension.js']);
  });
});
