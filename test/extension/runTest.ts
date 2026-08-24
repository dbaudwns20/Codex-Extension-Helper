import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

async function insidersExecutable(): Promise<string> {
  const legacyPath = await downloadAndUnzipVSCode('insiders');
  try {
    await access(legacyPath);
    return legacyPath;
  } catch {
    const currentPath = path.join(path.dirname(legacyPath), 'Code - Insiders');
    await access(currentPath);
    return currentPath;
  }
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
    await writeFile(path.join(workspacePath, 'smoke.ts'), 'const value = 1;\n', 'utf8');
    await writeFile(
      path.join(workspacePath, 'policy.ts'),
      `export const payload = "${'x'.repeat(1_400)}";\n`,
      'utf8',
    );
    await runTests({
      vscodeExecutablePath: await insidersExecutable(),
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: { CODEX_EXTENSION_HELPER_TEST: '1' },
      launchArgs: [
        workspacePath,
        '--disable-extensions',
        '--enable-proposed-api',
        'local.codex-extension-helper',
        `--user-data-dir=${userDataPath}`,
        `--extensions-dir=${extensionsPath}`,
      ],
    });
  } finally {
    await rm(temporaryPath, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
