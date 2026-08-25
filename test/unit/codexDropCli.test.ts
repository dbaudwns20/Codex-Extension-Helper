import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const composerAnchor = 'IR(`add-context-file`,it.view.dom,e=>{Ei(),bee([e.file])});';
const composerContext = 'const cwd="/workspace";const isHome=cwd===`~`;';
const temporaryDirectories: string[] = [];
const patchScript = path.resolve('scripts/patch-codex-drop.mjs');
const restoreScript = path.resolve('scripts/unpatch-codex-drop.mjs');

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-drop-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeInstallation(root: string, version: string, source = `${composerContext}before;${composerAnchor}after;`) {
  const extensionDir = path.join(root, `openai.chatgpt-${version}-darwin-arm64`);
  await mkdir(path.join(extensionDir, 'webview/assets'), { recursive: true });
  const indexSource = [
    '<!doctype html><html><head>',
    '<!-- PROD_CSP_TAG_HERE -->',
    '<script type="module" crossorigin src="./assets/index-current.js"></script>',
    '<link rel="modulepreload" crossorigin href="./assets/app-initial-current.js">',
    '</head><body><div id="root"></div></body></html>',
  ].join('\n');
  await writeFile(path.join(extensionDir, 'package.json'), JSON.stringify({ name: 'chatgpt', version }));
  await writeFile(path.join(extensionDir, 'webview/index.html'), indexSource);
  await writeFile(path.join(extensionDir, 'webview/assets/app-initial-current.js'), source);
  return extensionDir;
}

async function makeLegacyBundlePatchFixture(extensionDir: string, version: string) {
  // @ts-expect-error Script modules are intentionally JavaScript-only.
  const { patchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
  // @ts-expect-error Script modules are intentionally JavaScript-only.
  const { sha256 } = await import('../../scripts/lib/codex-drop-installation.mjs');
  const bundlePath = path.join(extensionDir, 'webview/assets/app-initial-current.js');
  const backupPath = `${bundlePath}.codex-explorer-drop-chips.original`;
  const metadataPath = `${bundlePath}.codex-explorer-drop-chips.json`;
  const originalBundle = await readFile(bundlePath, 'utf8');
  const patchedBundle = patchBundleSource(originalBundle).source;
  await writeFile(bundlePath, patchedBundle);
  await writeFile(backupPath, originalBundle);
  await writeFile(metadataPath, `${JSON.stringify({
    patchVersion: 8,
    extensionVersion: version,
    bundlePath,
    backupPath,
    originalSha256: sha256(originalBundle),
    patchedSha256: sha256(patchedBundle),
  }, null, 2)}\n`);
}

function run(scriptPath: string, ...arguments_: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...arguments_], { encoding: 'utf8' });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Codex drop patch CLIs', () => {
  it('reports schema-2 patch, already-patched, restored, and already-restored statuses', async () => {
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.818.61809');
    const bundlePath = path.join(extensionDir, 'webview/assets/app-initial-current.js');
    const indexPath = path.join(extensionDir, 'webview/index.html');

    const firstPatch = run(patchScript, '--extension-dir', extensionDir);
    expect(firstPatch.status).toBe(0);
    expect(firstPatch.stdout).toContain('Patched Codex 26.818.61809');
    expect(firstPatch.stdout).toContain(`Bundle: ${bundlePath}`);
    expect(firstPatch.stdout).toContain('The first Codex webview load will refresh its cache once.');
    expect(firstPatch.stdout).toContain('Reload VS Code');
    expect(firstPatch.stdout).toContain(`Index: ${indexPath}`);
    expect(firstPatch.stdout).toContain('Status: patched');

    const secondPatch = run(patchScript, '--extension-dir', extensionDir);
    expect(secondPatch.status).toBe(0);
    expect(secondPatch.stdout).toContain('already patched');
    expect(secondPatch.stdout).toContain(`Bundle: ${bundlePath}`);
    expect(secondPatch.stdout).toContain(`Index: ${indexPath}`);
    expect(secondPatch.stdout).toContain('Status: already-patched');
    expect(secondPatch.stdout).not.toContain('Reload VS Code');
    expect(secondPatch.stdout).not.toContain('The first Codex webview load will refresh its cache once.');

    const restore = run(restoreScript, '--extension-dir', extensionDir);
    expect(restore.status).toBe(0);
    expect(restore.stdout).toContain('Restored Codex 26.818.61809');
    expect(restore.stdout).toContain('Reload VS Code');
    expect(restore.stdout).toContain(`Index: ${indexPath}`);
    expect(restore.stdout).toContain('Status: restored');

    const secondRestore = run(restoreScript, '--extension-dir', extensionDir);
    expect(secondRestore.status).toBe(0);
    expect(secondRestore.stdout).toContain('already restored');
    expect(secondRestore.stdout).toContain(`Bundle: ${bundlePath}`);
    expect(secondRestore.stdout).toContain(`Index: ${indexPath}`);
    expect(secondRestore.stdout).toContain('Status: already-restored');
    expect(secondRestore.stdout).not.toContain('Reload VS Code');
    expect(secondRestore.stdout).not.toContain('The first Codex webview load will refresh its cache once.');
  });

  it('reports legacy migration with cache refresh guidance', async () => {
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.818.61809');
    const bundlePath = path.join(extensionDir, 'webview/assets/app-initial-current.js');
    await makeLegacyBundlePatchFixture(extensionDir, '26.818.61809');

    const migratedPatch = run(patchScript, '--extension-dir', extensionDir);
    expect(migratedPatch.status).toBe(0);
    expect(migratedPatch.stdout).toContain('Migrated Codex 26.818.61809');
    expect(migratedPatch.stdout).toContain(`Bundle: ${bundlePath}`);
    expect(migratedPatch.stdout).toContain('The first Codex webview load will refresh its cache once.');
    expect(migratedPatch.stdout).toContain('Reload VS Code');
    expect(migratedPatch.stdout).toContain(`Index: ${path.join(extensionDir, 'webview/index.html')}`);
    expect(migratedPatch.stdout).toContain('Status: migrated');
  });

  it('restores a legacy bundle-only patch under the current lifecycle contract', async () => {
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.818.61809');
    await makeLegacyBundlePatchFixture(extensionDir, '26.818.61809');

    const restore = run(restoreScript, '--extension-dir', extensionDir);
    expect(restore.status).toBe(0);
    expect(restore.stdout).toContain('Restored Codex 26.818.61809');
    expect(restore.stdout).toContain('Reload VS Code');
    expect(restore.stdout).toContain(`Bundle: ${path.join(extensionDir, 'webview/assets/app-initial-current.js')}`);
    expect(restore.stdout).toContain('Status: restored');
    expect(restore.stdout).not.toContain('Index:');
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
