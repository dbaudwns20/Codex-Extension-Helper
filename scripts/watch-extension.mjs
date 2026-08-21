import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';
import { extensionBuildOptions } from './esbuild-options.mjs';

const typeScriptPath = fileURLToPath(
  new URL('../node_modules/typescript/bin/tsc', import.meta.url),
);
let typeCheck;
let typeCheckClosed;
let typeCheckSpawnFailed = false;
let buildContext;
let stopping = false;

async function cleanup() {
  if (
    typeCheck !== undefined
    && typeCheckClosed !== undefined
    && !typeCheckSpawnFailed
    && typeCheck.exitCode === null
    && typeCheck.signalCode === null
  ) {
    typeCheck.kill('SIGTERM');
    const closed = await Promise.race([
      typeCheckClosed.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    if (!closed && typeCheck.exitCode === null && typeCheck.signalCode === null) {
      typeCheck.kill('SIGKILL');
    }
  }
  await typeCheckClosed;

  if (buildContext !== undefined) {
    await buildContext.dispose();
  }
}

async function stop(exitCode) {
  if (stopping) {
    return;
  }
  stopping = true;
  await cleanup();
  process.exit(exitCode);
}

process.once('SIGINT', () => void stop(130));
process.once('SIGTERM', () => void stop(143));

try {
  typeCheck = spawn(process.execPath, [
    typeScriptPath,
    '-p',
    '.',
    '--noEmit',
    '--watch',
    '--preserveWatchOutput',
  ], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  typeCheckClosed = new Promise((resolve) => typeCheck.once('close', resolve));
  typeCheck.once('error', (error) => {
    typeCheckSpawnFailed = true;
    console.error(error);
    void stop(1);
  });
  typeCheck.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[watch] TypeScript watcher exited (${code ?? signal ?? 'unknown'}).`);
      void stop(code ?? 1);
    }
  });

  buildContext = await context(extensionBuildOptions);
  await buildContext.watch();
  console.log('[watch] Watch workflow ready: TypeScript no-emit checks + esbuild runtime bundle.');
} catch (error) {
  stopping = true;
  try {
    await cleanup();
  } catch (cleanupError) {
    console.error('[watch] Cleanup after setup failure also failed:', cleanupError);
  }
  throw error;
}
