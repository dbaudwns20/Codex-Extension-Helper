import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import {
  resolveStableExecutable,
  withElectronRunAsNodeDisabled,
} from './stableExecutable';

async function stableExecutable(): Promise<string> {
  const legacyPath = await downloadAndUnzipVSCode('stable');
  return resolveStableExecutable(legacyPath);
}

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite/index');
  const temporaryPrefix = process.platform === 'darwin'
    ? '/tmp/cic-'
    : path.join(tmpdir(), 'cic-');
  const temporaryPath = await mkdtemp(temporaryPrefix);
  const workspacePath = path.join(temporaryPath, 'w');
  const userDataPath = path.join(temporaryPath, 'u');
  const extensionsPath = path.join(temporaryPath, 'e');

  try {
    await mkdir(workspacePath);
    await mkdir(path.join(workspacePath, '.vscode'));
    await writeFile(
      path.join(workspacePath, '.vscode', 'settings.json'),
      JSON.stringify({
        'codexExtensionHelper.debounceMs': 50,
        'codexExtensionHelper.maxFileSizeKb': 1,
      }),
      'utf8',
    );
    await Promise.all([
      ['approve.ts', 'const value = 1;'],
      ['reject.ts', 'const reject = "alpha-one-omega-two-end";'],
      ['approve-all.ts', 'const value = 20;'],
      ['reject-all.ts', 'const rejectAll = "red-middle-blue-tail";'],
      ['save.ts', 'const value = 40;'],
      ['delete.ts', 'const value = 50;'],
      ['eof-approve.ts', 'export const eofApprove = true;'],
      ['eof-reject.ts', 'export const first = 1;\r\nexport const eofReject = true;\r\n'],
    ].map(([name, text]) => writeFile(path.join(workspacePath, name), text, 'utf8')));
    await withElectronRunAsNodeDisabled(process.env, async () => runTests({
        vscodeExecutablePath: await stableExecutable(),
        extensionDevelopmentPath,
        extensionTestsPath,
        extensionTestsEnv: { CODEX_EXTENSION_HELPER_TEST: '1' },
        launchArgs: [
          workspacePath,
          '--disable-extensions',
          `--user-data-dir=${userDataPath}`,
          `--extensions-dir=${extensionsPath}`,
        ],
      }));
  } finally {
    await rm(temporaryPath, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
