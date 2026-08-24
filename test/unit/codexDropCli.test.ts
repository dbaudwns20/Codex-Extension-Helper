import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const composerAnchor = 'IR(`add-context-file`,it.view.dom,e=>{Ei(),bee([e.file])});';
const temporaryDirectories: string[] = [];
const patchScript = path.resolve('scripts/patch-codex-drop.mjs');
const restoreScript = path.resolve('scripts/unpatch-codex-drop.mjs');

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-drop-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeInstallation(root: string, version: string, source = `before;${composerAnchor}after;`) {
  const extensionDir = path.join(root, `openai.chatgpt-${version}-darwin-arm64`);
  await mkdir(path.join(extensionDir, 'webview/assets'), { recursive: true });
  await writeFile(path.join(extensionDir, 'package.json'), JSON.stringify({ name: 'chatgpt', version }));
  await writeFile(path.join(extensionDir, 'webview/assets/app-initial-current.js'), source);
  return extensionDir;
}

function run(scriptPath: string, ...arguments_: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...arguments_], { encoding: 'utf8' });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Codex drop patch CLIs', () => {
  it('patches, reports an existing patch, and restores an explicit installation', async () => {
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.818.61809');

    const firstPatch = run(patchScript, '--extension-dir', extensionDir);
    expect(firstPatch.status).toBe(0);
    expect(firstPatch.stdout).toContain('Patched Codex 26.818.61809');

    const secondPatch = run(patchScript, '--extension-dir', extensionDir);
    expect(secondPatch.status).toBe(0);
    expect(secondPatch.stdout).toContain('already patched');

    const restore = run(restoreScript, '--extension-dir', extensionDir);
    expect(restore.status).toBe(0);
    expect(restore.stdout).toContain('Restored Codex 26.818.61809');
  });

  it('prints concise errors for malformed arguments and incompatible installations', async () => {
    const malformed = run(patchScript, '--unexpected');
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain('Codex drop patch failed:');

    const root = await makeTemporaryDirectory();
    const incompatibleDir = await makeInstallation(root, '26.818.61809', 'unsupported bundle');
    const incompatible = run(restoreScript, '--extension-dir', incompatibleDir);
    expect(incompatible.status).toBe(1);
    expect(incompatible.stderr).toContain('Codex drop restore failed:');
  });
});
