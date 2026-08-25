import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const composerAnchor = 'IR(`add-context-file`,it.view.dom,e=>{Ei(),bee([e.file])});';
const composerContext = 'const cwd="/workspace";const isHome=cwd===`~`;';
const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-drop-installation-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeInstallation(root: string, version: string, bundleNames = ['app-initial-current.js']) {
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
  await Promise.all(bundleNames.map((bundleName) => writeFile(
    path.join(extensionDir, 'webview/assets', bundleName),

    `${composerContext}before;${composerAnchor}after;`,
  )));
  return extensionDir;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Codex drop installation discovery', () => {
  it('discovers installations and selects the numerically newest installation bundle', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { discoverCodexInstallations, resolveCodexTarget } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    await makeInstallation(extensionsRoot, '26.818.10000');
    await makeInstallation(extensionsRoot, '26.818.61809');
    await mkdir(path.join(extensionsRoot, 'unrelated-extension'), { recursive: true });
    await writeFile(path.join(extensionsRoot, 'unrelated-extension/package.json'), JSON.stringify({ name: 'not-chatgpt', version: '999.0.0' }));

    const installations = await discoverCodexInstallations({ roots: [extensionsRoot] });
    expect(installations.map(({ extensionVersion }: { extensionVersion: string }) => extensionVersion)).toEqual(['26.818.10000', '26.818.61809']);

    const target = await resolveCodexTarget({ roots: [extensionsRoot] });
    expect(target.extensionVersion).toBe('26.818.61809');
    expect(target.bundlePath).toBe(path.join(
      extensionsRoot,
      'openai.chatgpt-26.818.61809-darwin-arm64',
      'webview/assets/app-initial-current.js',
    ));
  });

  it('uses an explicitly selected extension directory', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { resolveCodexTarget } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    await makeInstallation(extensionsRoot, '26.818.10000');
    const explicit = await makeInstallation(extensionsRoot, '26.818.61809');

    const target = await resolveCodexTarget({ extensionDir: explicit });
    expect(target.extensionDir).toBe(explicit);
    expect(target.extensionVersion).toBe('26.818.61809');
  });

  it('fails closed when no matching installation exists', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { resolveCodexTarget } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    await mkdir(path.join(extensionsRoot, 'other-extension'), { recursive: true });

    await expect(resolveCodexTarget({ roots: [extensionsRoot] })).rejects.toThrow('No compatible Codex installation found');
  });

  it('fails closed when a matching installation has no compatible bundle', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { resolveCodexTarget } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = path.join(extensionsRoot, 'openai.chatgpt-26.818.61809-darwin-arm64');
    await mkdir(path.join(extensionDir, 'webview/assets'), { recursive: true });
    await writeFile(path.join(extensionDir, 'package.json'), JSON.stringify({ name: 'chatgpt', version: '26.818.61809' }));
    await writeFile(path.join(extensionDir, 'webview/assets/app-initial-current.js'), 'no composer here');

    await expect(resolveCodexTarget({ roots: [extensionsRoot] })).rejects.toThrow('No compatible Codex bundle found');
  });

  it('fails automatic patching when the newest installation has no compatible bundle', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const olderExtensionDir = await makeInstallation(extensionsRoot, '26.818.10000');
    const olderBundlePath = path.join(olderExtensionDir, 'webview/assets/app-initial-current.js');
    const olderSource = await readFile(olderBundlePath, 'utf8');
    const newerExtensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    await writeFile(path.join(newerExtensionDir, 'webview/assets/app-initial-current.js'), 'unsupported newer bundle');

    await expect(applyCodexDropPatch({ roots: [extensionsRoot] })).rejects.toThrow('No compatible Codex bundle found');
    expect(await readFile(olderBundlePath, 'utf8')).toBe(olderSource);
  });

  it('fails closed when multiple bundles contain the composer anchor', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { resolveCodexTarget } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    await makeInstallation(extensionsRoot, '26.818.61809', ['app-initial-one.js', 'app-initial-two.js']);

    await expect(resolveCodexTarget({ roots: [extensionsRoot] })).rejects.toThrow('Expected exactly one compatible Codex bundle');
  });
});

describe('Codex drop installation lifecycle', () => {
  it('patches, restores, and safely reuses its verified original backup', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch, restoreCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const bundlePath = path.join(extensionDir, 'webview/assets/app-initial-current.js');
    const originalSource = await readFile(bundlePath, 'utf8');

    const first = await applyCodexDropPatch({ extensionDir });
    expect(first.status).toBe('patched');
    expect(first.indexPath).toBe(path.join(extensionDir, 'webview/index.html'));
    expect(first.bootstrapPath).toBe(path.join(extensionDir, 'webview/assets/codex-explorer-drop-cache-bootstrap-v1.js'));
    const metadata = JSON.parse(await readFile(first.metadataPath, 'utf8'));
    expect(metadata.metadataSchemaVersion).toBe(2);
    expect(metadata.patchVersion).toBe(6);
    expect(metadata.cacheBootstrapVersion).toBe(1);
    expect(await readFile(first.indexPath, 'utf8')).toContain('codex-explorer-drop-cache-bootstrap-v1.js');
    expect(await readFile(first.bootstrapPath, 'utf8')).toContain('./assets/index-current.js');

    const second = await applyCodexDropPatch({ extensionDir });
    expect(second.status).toBe('already-patched');

    const restored = await restoreCodexDropPatch({ extensionDir });
    expect(restored.status).toBe('restored');
    expect(await readFile(bundlePath, 'utf8')).toBe(originalSource);

    const secondRestore = await restoreCodexDropPatch({ extensionDir });
    expect(secondRestore.status).toBe('already-restored');

    const legacyMetadata = JSON.parse(await readFile(first.metadataPath, 'utf8'));
    legacyMetadata.patchVersion = 1;
    legacyMetadata.patchedSha256 = '0'.repeat(64);
    await writeFile(first.metadataPath, `${JSON.stringify(legacyMetadata, null, 2)}\n`);

    const repatched = await applyCodexDropPatch({ extensionDir });
    expect(repatched.status).toBe('patched');
    expect(repatched.backupPath).toBe(first.backupPath);
    expect(await readFile(first.metadataPath, 'utf8')).toContain('"patchVersion": 6');
  });

  it('migrates a verified legacy v6 bundle patch to schema 2 without rewriting the bundle backup', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch, sha256 } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const bundlePath = path.join(extensionDir, 'webview/assets/app-initial-current.js');
    const backupPath = `${bundlePath}.codex-explorer-drop-chips.original`;
    const metadataPath = `${bundlePath}.codex-explorer-drop-chips.json`;
    const originalBundle = await readFile(bundlePath, 'utf8');
    const patchedBundle = patchBundleSource(originalBundle).source;
    await writeFile(bundlePath, patchedBundle);
    await writeFile(backupPath, originalBundle);
    await writeFile(metadataPath, `${JSON.stringify({
      patchVersion: 6,
      extensionVersion: '26.818.61809',
      bundlePath,
      backupPath,
      originalSha256: sha256(originalBundle),
      patchedSha256: sha256(patchedBundle),
    }, null, 2)}\n`);
    const bundleBeforeMigration = await readFile(bundlePath);
    const backupBeforeMigration = await readFile(backupPath);

    const migrated = await applyCodexDropPatch({ extensionDir });
    expect(migrated.status).toBe('migrated');
    expect(await readFile(bundlePath)).toEqual(bundleBeforeMigration);
    expect(await readFile(backupPath)).toEqual(backupBeforeMigration);
    expect(JSON.parse(await readFile(metadataPath, 'utf8')).metadataSchemaVersion).toBe(2);
  });

  it('refuses to restore a patched bundle changed after patching', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch, restoreCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const first = await applyCodexDropPatch({ extensionDir });
    await writeFile(first.bundlePath, 'modified after patching');

    await expect(restoreCodexDropPatch({ extensionDir })).rejects.toThrow('Current bundle hash does not match patch metadata');
  });

  it('refuses to restore when the original backup has changed', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch, restoreCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const first = await applyCodexDropPatch({ extensionDir });
    await writeFile(first.backupPath, 'modified backup');

    await expect(restoreCodexDropPatch({ extensionDir })).rejects.toThrow('Backup hash does not match patch metadata');
  });

  it('refuses to overwrite stale metadata that has no original backup', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const bundlePath = path.join(extensionDir, 'webview/assets/app-initial-current.js');
    const metadataPath = `${bundlePath}.codex-explorer-drop-chips.json`;
    const originalSource = await readFile(bundlePath, 'utf8');
    await writeFile(metadataPath, '{"unrelated":true}\n');

    await expect(applyCodexDropPatch({ extensionDir })).rejects.toThrow('Existing Codex drop patch metadata has no backup');
    expect(await readFile(bundlePath, 'utf8')).toBe(originalSource);
    expect(await readFile(metadataPath, 'utf8')).toBe('{"unrelated":true}\n');
  });
});
