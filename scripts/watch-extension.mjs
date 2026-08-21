import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';
import { extensionBuildOptions } from './esbuild-options.mjs';

const typeScriptPath = fileURLToPath(
  new URL('../node_modules/typescript/bin/tsc', import.meta.url),
);
let typeCheck;
let buildContext;
let stopping = false;

async function cleanup() {
  if (typeCheck?.exitCode === null) {
    const typeCheckExit = once(typeCheck, 'exit').then(() => true, () => true);
    typeCheck.kill('SIGTERM');
    const exited = await Promise.race([
      typeCheckExit,
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    if (!exited && typeCheck.exitCode === null) {
      typeCheck.kill('SIGKILL');
      await typeCheckExit;
    }
  }

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
  typeCheck.once('error', (error) => {
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
