import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectPath = path.resolve('.');

async function waitFor(
  description: string,
  predicate: () => Promise<boolean> | boolean,
  child: ChildProcess,
  output: () => string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    if (child.exitCode !== null) {
      throw new Error(`${description}: watcher exited with ${child.exitCode}\n${output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${description}: timed out\n${output()}`);
}

async function stopProcessGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) {
    return;
  }

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (process.platform === 'win32') {
    child.kill('SIGTERM');
  } else {
    process.kill(-child.pid, 'SIGTERM');
  }

  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

async function loadIsolatedRuntime(entryPath: string): Promise<ReturnType<typeof spawn>> {
  const temporaryPath = await mkdtemp(path.join(tmpdir(), 'codex-inline-watch-runtime-'));
  const runtimePath = path.join(temporaryPath, 'out', 'src');
  const vscodeStubPath = path.join(temporaryPath, 'node_modules', 'vscode');
  await mkdir(runtimePath, { recursive: true });
  await mkdir(vscodeStubPath, { recursive: true });
  await copyFile(entryPath, path.join(runtimePath, 'extension.js'));
  await writeFile(
    path.join(vscodeStubPath, 'package.json'),
    JSON.stringify({ name: 'vscode', version: '0.0.0', main: 'index.js' }),
    'utf8',
  );
  await writeFile(path.join(vscodeStubPath, 'index.js'), 'module.exports = {};\n', 'utf8');

  const child = spawn(process.execPath, ['-e', 'require(process.argv[1])', path.join(runtimePath, 'extension.js')], {
    cwd: temporaryPath,
    stdio: 'pipe',
  });
  child.once('exit', () => void rm(temporaryPath, { recursive: true, force: true }));
  return child;
}

describe('watch workflow', () => {
  it('keeps the rebuilt runtime self-contained after a source edit', async () => {
    const sourcePath = path.join(projectPath, 'src', 'extension.ts');
    const entryPath = path.join(projectPath, 'out', 'src', 'extension.js');
    const originalSource = await readFile(sourcePath, 'utf8');
    const probe = `__watchOwnershipProbe${Date.now()}`;
    let output = '';
    const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const watcher = spawn(npmExecutable, ['run', 'watch'], {
      cwd: projectPath,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    watcher.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    watcher.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });

    try {
      await waitFor(
        'watch workflow to start',
        () => /watching for file changes|watch workflow ready/iu.test(output),
        watcher,
        () => output,
      );

      output = '';
      await writeFile(sourcePath, `${originalSource}\nexport const ${probe} = true;\n`, 'utf8');
      await waitFor(
        'esbuild to rebuild the exported probe',
        async () => (await readFile(entryPath, 'utf8')).includes(probe),
        watcher,
        () => output,
      );
      await waitFor(
        'TypeScript to finish its post-edit no-emit check',
        () => /found 0 errors\. watching for file changes/iu.test(output),
        watcher,
        () => output,
      );

      const isolatedRuntime = await loadIsolatedRuntime(entryPath);
      let runtimeError = '';
      isolatedRuntime.stderr?.on('data', (chunk: Buffer) => { runtimeError += chunk.toString(); });
      const runtimeExit = await new Promise<number | null>((resolve) => {
        isolatedRuntime.once('exit', (code) => resolve(code));
      });
      expect(runtimeExit, runtimeError).toBe(0);
    } finally {
      await writeFile(sourcePath, originalSource, 'utf8');
      await waitFor(
        'esbuild to restore the runtime after the probe is removed',
        async () => !(await readFile(entryPath, 'utf8')).includes(probe),
        watcher,
        () => output,
      );
      await stopProcessGroup(watcher);
    }
  }, 20_000);
});
