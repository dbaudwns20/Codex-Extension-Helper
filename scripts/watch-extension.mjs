import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';
import { extensionBuildOptions } from './esbuild-options.mjs';

const typeScriptPath = fileURLToPath(
  new URL('../node_modules/typescript/bin/tsc', import.meta.url),
);
const typeCheck = spawn(process.execPath, [
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
const buildContext = await context(extensionBuildOptions);
let stopping = false;

async function stop(exitCode) {
  if (stopping) {
    return;
  }
  stopping = true;

  if (typeCheck.exitCode === null) {
    const typeCheckExit = once(typeCheck, 'exit');
    typeCheck.kill('SIGTERM');
    await Promise.race([
      typeCheckExit,
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  await buildContext.dispose();
  process.exit(exitCode);
}

process.once('SIGINT', () => void stop(130));
process.once('SIGTERM', () => void stop(143));
typeCheck.once('exit', (code, signal) => {
  if (!stopping) {
    console.error(`[watch] TypeScript watcher exited (${code ?? signal ?? 'unknown'}).`);
    void stop(code ?? 1);
  }
});

try {
  await buildContext.watch();
  console.log('[watch] Watch workflow ready: TypeScript no-emit checks + esbuild runtime bundle.');
} catch (error) {
  console.error(error);
  await stop(1);
}
