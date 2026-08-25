import { mkdtemp, mkdir, readFile, rename as fsRename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const composerAnchor = 'IR(`add-context-file`,it.view.dom,e=>{Ei(),bee([e.file])});';
const composerContext = 'const cwd="/workspace";const isHome=cwd===`~`;';
const temporaryDirectories: string[] = [];
type PatchResultPaths = {
  backupPath: string;
  bootstrapPath: string;
  bundlePath: string;
  indexBackupPath: string;
  indexPath: string;
};

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

async function makeLegacyBundlePatchFixture(extensionDir: string) {
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
    patchVersion: 6,
    extensionVersion: '26.818.61809',
    bundlePath,
    backupPath,
    originalSha256: sha256(originalBundle),
    patchedSha256: sha256(patchedBundle),
  }, null, 2)}\n`);
  return {
    backupPath,
    bundlePath,
    metadataPath,
    originalBundle,
    patchedBundle,
  };
}

const cacheBootstrapV1BehaviorSource = `async function executeCacheBootstrap({ cacheStorage, storage, reload, importEntry, reportError }) {
  const state = storage.getItem(CACHE_STATE_KEY);
  if (state === 'ready') {
    await importEntry();
    return 'imported';
  }
  if (state === 'failed') {
    await importEntry();
    return 'fallback';
  }
  try {
    if (cacheStorage === undefined) throw new Error('Cache Storage API is unavailable');
    const names = await cacheStorage.keys();
    await Promise.all(names.map((name) => cacheStorage.delete(name)));
    storage.setItem(CACHE_STATE_KEY, 'ready');
    reload();
    return 'reloaded';
  } catch (error) {
    storage.setItem(CACHE_STATE_KEY, 'failed');
    reportError(error);
    await importEntry();
    return 'fallback';
  }
}`;

function createCacheBootstrapV1Source(entrySource: string) {
  return `const CACHE_STATE_KEY="codex-explorer-drop-cache:v1";const executeCacheBootstrap=${cacheBootstrapV1BehaviorSource};const entryUrl=new URL(${JSON.stringify(entrySource)},document.baseURI).href;await executeCacheBootstrap({cacheStorage:globalThis.caches,storage:globalThis.sessionStorage,reload:()=>globalThis.location.reload(),importEntry:()=>import(entryUrl),reportError:(error)=>console.error('Codex drop cache refresh failed',error)});\n`;
}

function patchIndexV1(source: string) {
  const entry = /<script\s+type="module"\s+crossorigin\s+src="(?<entrySource>\.\/assets\/index-[^"]+\.js)"><\/script>/u.exec(source);
  if (entry?.index === undefined || entry.groups?.entrySource === undefined) throw new Error('Invalid test index fixture');
  const encodedTag = Buffer.from(entry[0], 'utf8').toString('base64');
  const replacement = `<!-- codex-explorer-drop-cache:start:v1 --><script type="module" crossorigin src="./assets/codex-explorer-drop-cache-bootstrap-v1.js"></script><!-- codex-explorer-drop-cache:original:${encodedTag} --><!-- codex-explorer-drop-cache:end:v1 -->`;
  return {
    entrySource: entry.groups.entrySource,
    source: source.slice(0, entry.index) + replacement + source.slice(entry.index + entry[0].length),
  };
}

async function makeSchema2V1PatchFixture(extensionDir: string) {
  // @ts-expect-error Script modules are intentionally JavaScript-only.
  const { patchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
  // @ts-expect-error Script modules are intentionally JavaScript-only.
  const { sha256 } = await import('../../scripts/lib/codex-drop-installation.mjs');
  const bundlePath = path.join(extensionDir, 'webview/assets/app-initial-current.js');
  const backupPath = `${bundlePath}.codex-explorer-drop-chips.original`;
  const metadataPath = `${bundlePath}.codex-explorer-drop-chips.json`;
  const indexPath = path.join(extensionDir, 'webview/index.html');
  const indexBackupPath = `${indexPath}.codex-explorer-drop-chips.original`;
  const bootstrapPath = path.join(extensionDir, 'webview/assets/codex-explorer-drop-cache-bootstrap-v1.js');
  const originalBundle = await readFile(bundlePath, 'utf8');
  const patchedBundle = patchBundleSource(originalBundle).source;
  const originalIndex = await readFile(indexPath, 'utf8');
  const patchedIndex = patchIndexV1(originalIndex);
  const bootstrapSource = createCacheBootstrapV1Source(patchedIndex.entrySource);
  const metadata = {
    metadataSchemaVersion: 2,
    patchVersion: 6,
    cacheBootstrapVersion: 1,
    extensionVersion: '26.818.61809',
    bundlePath,
    backupPath,
    originalSha256: sha256(originalBundle),
    patchedSha256: sha256(patchedBundle),
    indexPath,
    indexBackupPath,
    originalIndexSha256: sha256(originalIndex),
    patchedIndexSha256: sha256(patchedIndex.source),
    bootstrapPath,
    bootstrapSha256: sha256(bootstrapSource),
    entrySource: patchedIndex.entrySource,
  };

  await writeFile(bundlePath, patchedBundle);
  await writeFile(backupPath, originalBundle);
  await writeFile(indexPath, patchedIndex.source);
  await writeFile(indexBackupPath, originalIndex);
  await writeFile(bootstrapPath, bootstrapSource);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return {
    ...metadata,
    bootstrapSource,
    metadataPath,
    originalBundle,
    originalIndex,
    patchedBundle,
    patchedIndex: patchedIndex.source,
  };
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
    const indexPath = path.join(extensionDir, 'webview/index.html');
    const originalBundle = await readFile(bundlePath);
    const originalIndex = await readFile(indexPath);

    const first = await applyCodexDropPatch({ extensionDir });
    expect(first.status).toBe('patched');
    expect(first.indexPath).toBe(indexPath);
    expect(first.bootstrapPath).toBe(path.join(extensionDir, 'webview/assets/codex-explorer-drop-cache-bootstrap-v2.js'));
    const metadata = JSON.parse(await readFile(first.metadataPath, 'utf8'));
    expect(metadata.metadataSchemaVersion).toBe(2);
    expect(metadata.patchVersion).toBe(6);
    expect(metadata.cacheBootstrapVersion).toBe(2);
    expect(await readFile(first.indexPath, 'utf8')).toContain('codex-explorer-drop-cache-bootstrap-v2.js');
    expect(await readFile(first.bootstrapPath, 'utf8')).toContain('./assets/index-current.js');

    const second = await applyCodexDropPatch({ extensionDir });
    expect(second.status).toBe('already-patched');

    const restored = await restoreCodexDropPatch({ extensionDir });
    expect(restored.status).toBe('restored');
    expect(await readFile(bundlePath)).toEqual(originalBundle);
    expect(await readFile(indexPath)).toEqual(originalIndex);
    await expect(readFile(first.bootstrapPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const secondRestore = await restoreCodexDropPatch({ extensionDir });
    expect(secondRestore.status).toBe('already-restored');

    const corruptedMetadata = JSON.parse(await readFile(first.metadataPath, 'utf8'));
    corruptedMetadata.patchVersion = 1;
    corruptedMetadata.patchedSha256 = '0'.repeat(64);
    const corruptedMetadataSource = `${JSON.stringify(corruptedMetadata, null, 2)}\n`;
    await writeFile(first.metadataPath, corruptedMetadataSource);

    await expect(applyCodexDropPatch({ extensionDir })).rejects.toThrow('Codex drop patch metadata is invalid');
    expect(await readFile(first.metadataPath, 'utf8')).toBe(corruptedMetadataSource);
  });

  it('migrates a verified legacy v6 bundle patch to schema 2 without rewriting the bundle backup', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const { backupPath, bundlePath, metadataPath } = await makeLegacyBundlePatchFixture(extensionDir);
    const bundleBeforeMigration = await readFile(bundlePath);
    const backupBeforeMigration = await readFile(backupPath);

    const migrated = await applyCodexDropPatch({ extensionDir });
    expect(migrated.status).toBe('migrated');
    expect(await readFile(bundlePath)).toEqual(bundleBeforeMigration);
    expect(await readFile(backupPath)).toEqual(backupBeforeMigration);
    expect(JSON.parse(await readFile(metadataPath, 'utf8')).metadataSchemaVersion).toBe(2);
  });

  it('migrates a verified schema-2 bootstrap-v1 install to bootstrap v2', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const fixture = await makeSchema2V1PatchFixture(extensionDir);
    const bundleBeforeMigration = await readFile(fixture.bundlePath);
    const bundleBackupBeforeMigration = await readFile(fixture.backupPath);
    const indexBackupBeforeMigration = await readFile(fixture.indexBackupPath);

    const migrated = await applyCodexDropPatch({ extensionDir });

    expect(migrated.status).toBe('migrated');
    expect(migrated.bootstrapPath).toBe(path.join(extensionDir, 'webview/assets/codex-explorer-drop-cache-bootstrap-v2.js'));
    expect(await readFile(fixture.bundlePath)).toEqual(bundleBeforeMigration);
    expect(await readFile(fixture.backupPath)).toEqual(bundleBackupBeforeMigration);
    expect(await readFile(fixture.indexBackupPath)).toEqual(indexBackupBeforeMigration);
    expect(await readFile(fixture.indexPath, 'utf8')).toContain('codex-explorer-drop-cache-bootstrap-v2.js');
    expect(await readFile(migrated.bootstrapPath, 'utf8')).toContain('codex-explorer-drop-cache:v2');
    await expect(readFile(fixture.bootstrapPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const metadata = JSON.parse(await readFile(fixture.metadataPath, 'utf8'));
    expect(metadata.cacheBootstrapVersion).toBe(2);
    expect(metadata.bootstrapPath).toBe(migrated.bootstrapPath);
    expect((await applyCodexDropPatch({ extensionDir })).status).toBe('already-patched');
  });

  it('restores a verified schema-2 bootstrap-v1 install with its versioned bootstrap path', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { restoreCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const fixture = await makeSchema2V1PatchFixture(extensionDir);

    const restored = await restoreCodexDropPatch({ extensionDir });

    expect(restored.status).toBe('restored');
    expect(restored.bootstrapPath).toBe(fixture.bootstrapPath);
    expect(await readFile(fixture.bundlePath, 'utf8')).toBe(fixture.originalBundle);
    expect(await readFile(fixture.indexPath, 'utf8')).toBe(fixture.originalIndex);
    await expect(readFile(fixture.bootstrapPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await restoreCodexDropPatch({ extensionDir })).status).toBe('already-restored');
  });

  it.each([
    ['current bundle', async (fixture: Awaited<ReturnType<typeof makeSchema2V1PatchFixture>>) => writeFile(fixture.bundlePath, 'tampered bundle')],
    ['bundle backup', async (fixture: Awaited<ReturnType<typeof makeSchema2V1PatchFixture>>) => writeFile(fixture.backupPath, 'tampered bundle backup')],
    ['current index', async (fixture: Awaited<ReturnType<typeof makeSchema2V1PatchFixture>>) => writeFile(fixture.indexPath, 'tampered index')],
    ['index backup', async (fixture: Awaited<ReturnType<typeof makeSchema2V1PatchFixture>>) => writeFile(fixture.indexBackupPath, 'tampered index backup')],
    ['current bootstrap', async (fixture: Awaited<ReturnType<typeof makeSchema2V1PatchFixture>>) => writeFile(fixture.bootstrapPath, 'tampered bootstrap')],
    ['missing bootstrap', async (fixture: Awaited<ReturnType<typeof makeSchema2V1PatchFixture>>) => rm(fixture.bootstrapPath)],
    ['coordinated index and metadata hashes', async (fixture: Awaited<ReturnType<typeof makeSchema2V1PatchFixture>>) => {
      // @ts-expect-error Script modules are intentionally JavaScript-only.
      const { sha256 } = await import('../../scripts/lib/codex-drop-installation.mjs');
      const source = fixture.patchedIndex.replace('codex-explorer-drop-cache-bootstrap-v1.js', 'tampered-v1.js');
      await writeFile(fixture.indexPath, source);
      const metadata = JSON.parse(await readFile(fixture.metadataPath, 'utf8'));
      metadata.patchedIndexSha256 = sha256(source);
      await writeFile(fixture.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    }],
    ['coordinated bootstrap and metadata hashes', async (fixture: Awaited<ReturnType<typeof makeSchema2V1PatchFixture>>) => {
      // @ts-expect-error Script modules are intentionally JavaScript-only.
      const { sha256 } = await import('../../scripts/lib/codex-drop-installation.mjs');
      const source = `${fixture.bootstrapSource}// tampered\n`;
      await writeFile(fixture.bootstrapPath, source);
      const metadata = JSON.parse(await readFile(fixture.metadataPath, 'utf8'));
      metadata.bootstrapSha256 = sha256(source);
      await writeFile(fixture.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    }],
  ])('rejects a partial or tampered bootstrap-v1 migration for %s without mutation', async (_name, tamper) => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const fixture = await makeSchema2V1PatchFixture(extensionDir);
    const v2BootstrapPath = path.join(extensionDir, 'webview/assets/codex-explorer-drop-cache-bootstrap-v2.js');
    const managedPaths = [
      fixture.bundlePath,
      fixture.backupPath,
      fixture.indexPath,
      fixture.indexBackupPath,
      fixture.bootstrapPath,
      v2BootstrapPath,
      fixture.metadataPath,
    ];
    const readState = async () => Promise.all(managedPaths.map(async (filePath) => {
      try {
        return await readFile(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    }));
    await tamper(fixture);
    const stateBeforeMigration = await readState();

    await expect(applyCodexDropPatch({ extensionDir })).rejects.toThrow();

    expect(await readState()).toEqual(stateBeforeMigration);
  });

  it('rejects schema-2 metadata with its schema marker removed before restore mutation', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch, restoreCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const result = await applyCodexDropPatch({ extensionDir });
    const metadata = JSON.parse(await readFile(result.metadataPath, 'utf8'));
    delete metadata.metadataSchemaVersion;
    await writeFile(result.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    const bundleBeforeRestore = await readFile(result.bundlePath);
    const indexBeforeRestore = await readFile(result.indexPath);

    await expect(restoreCodexDropPatch({ extensionDir })).rejects.toThrow('Codex drop patch metadata is invalid');

    expect(await readFile(result.bundlePath)).toEqual(bundleBeforeRestore);
    expect(await readFile(result.indexPath)).toEqual(indexBeforeRestore);
  });

  it('rejects a corrupted restored legacy patched hash before reapply mutation', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch, restoreCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const fixture = await makeLegacyBundlePatchFixture(extensionDir);
    await restoreCodexDropPatch({ extensionDir });
    const metadata = JSON.parse(await readFile(fixture.metadataPath, 'utf8'));
    metadata.patchedSha256 = 'f'.repeat(64);
    const corruptedMetadataSource = `${JSON.stringify(metadata, null, 2)}\n`;
    await writeFile(fixture.metadataPath, corruptedMetadataSource);
    const bundleBeforeReapply = await readFile(fixture.bundlePath);
    const indexPath = path.join(extensionDir, 'webview/index.html');
    const indexBeforeReapply = await readFile(indexPath);

    await expect(applyCodexDropPatch({ extensionDir })).rejects.toThrow('Codex drop patch metadata is invalid');

    expect(await readFile(fixture.bundlePath)).toEqual(bundleBeforeReapply);
    expect(await readFile(indexPath)).toEqual(indexBeforeReapply);
    expect(await readFile(fixture.metadataPath, 'utf8')).toBe(corruptedMetadataSource);
  });

  it.each([
    ['first target rename', (extensionDir: string) => path.join(extensionDir, 'webview/assets/codex-explorer-drop-cache-bootstrap-v2.js')],
    ['second target rename', (extensionDir: string) => path.join(extensionDir, 'webview/index.html')],
  ])('preserves original backups and publishes no metadata after %s failure', async (_name, failedTarget) => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const bundlePath = path.join(extensionDir, 'webview/assets/app-initial-current.js');
    const indexPath = path.join(extensionDir, 'webview/index.html');
    const bootstrapPath = path.join(extensionDir, 'webview/assets/codex-explorer-drop-cache-bootstrap-v2.js');
    const backupPath = `${bundlePath}.codex-explorer-drop-chips.original`;
    const indexBackupPath = `${indexPath}.codex-explorer-drop-chips.original`;
    const metadataPath = `${bundlePath}.codex-explorer-drop-chips.json`;
    const originalBundle = await readFile(bundlePath);
    const originalIndex = await readFile(indexPath);
    const targetToFail = failedTarget(extensionDir);

    await expect(applyCodexDropPatch({
      extensionDir,
      __testFileOperations: {
        rename: async (sourcePath: string, targetPath: string) => {
          if (targetPath === targetToFail) throw new Error(`${_name} blocked`);
          await fsRename(sourcePath, targetPath);
        },
      },
    })).rejects.toThrow(`${_name} blocked`);

    expect(await readFile(bundlePath)).toEqual(originalBundle);
    expect(await readFile(indexPath)).toEqual(originalIndex);
    expect(await readFile(backupPath)).toEqual(originalBundle);
    expect(await readFile(indexBackupPath)).toEqual(originalIndex);
    await expect(readFile(metadataPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(bootstrapPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('attempts every install rollback and reports rollback failures while preserving recovery backups', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const bundlePath = path.join(extensionDir, 'webview/assets/app-initial-current.js');
    const indexPath = path.join(extensionDir, 'webview/index.html');
    const bootstrapPath = path.join(extensionDir, 'webview/assets/codex-explorer-drop-cache-bootstrap-v2.js');
    const backupPath = `${bundlePath}.codex-explorer-drop-chips.original`;
    const indexBackupPath = `${indexPath}.codex-explorer-drop-chips.original`;
    const metadataPath = `${bundlePath}.codex-explorer-drop-chips.json`;
    const originalBundle = await readFile(bundlePath);
    const originalIndex = await readFile(indexPath);
    const targetAttempts = new Map<string, number>();
    const renameWithFaults = async (sourcePath: string, targetPath: string) => {
      const attempt = (targetAttempts.get(targetPath) ?? 0) + 1;
      targetAttempts.set(targetPath, attempt);
      if (targetPath === metadataPath) throw new Error('metadata install blocked');
      if (targetPath === bundlePath && attempt === 2) throw new Error('bundle rollback blocked');
      await fsRename(sourcePath, targetPath);
    };

    await expect(applyCodexDropPatch({
      extensionDir,
      __testFileOperations: { rename: renameWithFaults },
    })).rejects.toThrow(/metadata install blocked.*bundle rollback blocked/u);

    expect(targetAttempts.get(bundlePath)).toBe(2);
    expect(targetAttempts.get(indexPath)).toBe(2);
    expect(await readFile(indexPath)).toEqual(originalIndex);
    expect(await readFile(backupPath)).toEqual(originalBundle);
    expect(await readFile(indexBackupPath)).toEqual(originalIndex);
    await expect(readFile(metadataPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(bootstrapPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls schema-2 index restoration back when the second target rename fails', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch, restoreCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const result = await applyCodexDropPatch({ extensionDir });
    const patchedBundle = await readFile(result.bundlePath);
    const patchedIndex = await readFile(result.indexPath);
    const bootstrapSource = await readFile(result.bootstrapPath);
    const indexAttempts: number[] = [];

    await expect(restoreCodexDropPatch({
      extensionDir,
      __testFileOperations: {
        rename: async (sourcePath: string, targetPath: string) => {
          if (targetPath === result.indexPath) indexAttempts.push(indexAttempts.length + 1);
          if (targetPath === result.bundlePath) throw new Error('second restore rename blocked');
          await fsRename(sourcePath, targetPath);
        },
      },
    })).rejects.toThrow('second restore rename blocked');

    expect(indexAttempts).toHaveLength(2);
    expect(await readFile(result.bundlePath)).toEqual(patchedBundle);
    expect(await readFile(result.indexPath)).toEqual(patchedIndex);
    expect(await readFile(result.bootstrapPath)).toEqual(bootstrapSource);
  });

  it('reports a schema-2 restore rollback failure and preserves its recovery files', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch, restoreCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const result = await applyCodexDropPatch({ extensionDir });
    const bundleBackup = await readFile(result.backupPath);
    const indexBackup = await readFile(result.indexBackupPath);
    let indexAttempts = 0;

    await expect(restoreCodexDropPatch({
      extensionDir,
      __testFileOperations: {
        rename: async (sourcePath: string, targetPath: string) => {
          if (targetPath === result.indexPath) {
            indexAttempts += 1;
            if (indexAttempts === 2) throw new Error('index restore rollback blocked');
          }
          if (targetPath === result.bundlePath) throw new Error('bundle restore blocked');
          await fsRename(sourcePath, targetPath);
        },
      },
    })).rejects.toThrow(/bundle restore blocked.*index restore rollback blocked/u);

    expect(indexAttempts).toBe(2);
    expect(await readFile(result.backupPath)).toEqual(bundleBackup);
    expect(await readFile(result.indexBackupPath)).toEqual(indexBackup);
    expect(await readFile(result.bootstrapPath)).toBeDefined();
    expect(await readFile(result.metadataPath)).toBeDefined();
  });

  it.each([
    ['bundle', (result: PatchResultPaths) => result.bundlePath, 'Current bundle hash does not match patch metadata'],
    ['index', (result: PatchResultPaths) => result.indexPath, 'Current index hash does not match patch metadata'],
    ['bundle backup', (result: PatchResultPaths) => result.backupPath, 'Backup hash does not match patch metadata'],
    ['index backup', (result: PatchResultPaths) => result.indexBackupPath, 'Index backup hash does not match patch metadata'],
    ['bootstrap', (result: PatchResultPaths) => result.bootstrapPath, 'Bootstrap hash does not match patch metadata'],
  ])('refuses restore after %s changes', async (_name, selectPath, expected) => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch, restoreCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const result = await applyCodexDropPatch({ extensionDir });
    await writeFile(selectPath(result), 'modified after patching');
    const bundleBeforeRestore = await readFile(result.bundlePath);
    const indexBeforeRestore = await readFile(result.indexPath);

    await expect(restoreCodexDropPatch({ extensionDir })).rejects.toThrow(expected);
    expect(await readFile(result.bundlePath)).toEqual(bundleBeforeRestore);
    expect(await readFile(result.indexPath)).toEqual(indexBeforeRestore);
  });

  it('restores a legacy metadata bundle patch without touching index.html or bootstrap assets', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { restoreCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const indexPath = path.join(extensionDir, 'webview/index.html');
    const originalIndex = await readFile(indexPath);
    const { bundlePath, originalBundle } = await makeLegacyBundlePatchFixture(extensionDir);

    const restored = await restoreCodexDropPatch({ extensionDir });
    expect(restored.status).toBe('restored');
    expect(restored).not.toHaveProperty('indexPath');
    expect(restored).not.toHaveProperty('indexBackupPath');
    expect(restored).not.toHaveProperty('bootstrapPath');
    expect(await readFile(bundlePath, 'utf8')).toBe(originalBundle);
    expect(await readFile(indexPath)).toEqual(originalIndex);
    await expect(readFile(path.join(extensionDir, 'webview/assets/codex-explorer-drop-cache-bootstrap-v2.js'))).rejects.toMatchObject({ code: 'ENOENT' });

    const alreadyRestored = await restoreCodexDropPatch({ extensionDir });
    expect(alreadyRestored.status).toBe('already-restored');
    expect(alreadyRestored).not.toHaveProperty('indexPath');
    expect(alreadyRestored).not.toHaveProperty('indexBackupPath');
    expect(alreadyRestored).not.toHaveProperty('bootstrapPath');
  });

  it('refuses to restore from already-restored files when the managed bootstrap artifact is tampered', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch, restoreCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const extensionsRoot = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
    const first = await applyCodexDropPatch({ extensionDir });
    await restoreCodexDropPatch({ extensionDir });
    const bundleBeforeRetry = await readFile(first.bundlePath);
    const indexBeforeRetry = await readFile(first.indexPath);
    await writeFile(first.bootstrapPath, 'tampered bootstrap');

    await expect(restoreCodexDropPatch({ extensionDir })).rejects.toThrow('Bootstrap hash does not match patch metadata');
    expect(await readFile(first.bundlePath)).toEqual(bundleBeforeRetry);
    expect(await readFile(first.indexPath)).toEqual(indexBeforeRetry);
    expect(await readFile(first.bootstrapPath, 'utf8')).toBe('tampered bootstrap');
  });

  it('refuses to reapply from restored files when schema-2 metadata fields are independently corrupted', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { applyCodexDropPatch, restoreCodexDropPatch } = await import('../../scripts/lib/codex-drop-installation.mjs');
    const corruptions = [
      { field: 'patchVersion', value: 5 },
      { field: 'cacheBootstrapVersion', value: 9 },
      { field: 'patchedSha256', value: '1'.repeat(64) },
      { field: 'patchedIndexSha256', value: '2'.repeat(64) },
      { field: 'bootstrapSha256', value: '3'.repeat(64) },
      { field: 'entrySource', value: './assets/index-corrupted.js' },
    ] as const;

    for (const corruption of corruptions) {
      const extensionsRoot = await makeTemporaryDirectory();
      const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
      const first = await applyCodexDropPatch({ extensionDir });
      await restoreCodexDropPatch({ extensionDir });
      const metadata = JSON.parse(await readFile(first.metadataPath, 'utf8'));
      metadata[corruption.field] = corruption.value;
      const corruptedMetadata = `${JSON.stringify(metadata, null, 2)}\n`;
      await writeFile(first.metadataPath, corruptedMetadata);

      await expect(applyCodexDropPatch({ extensionDir })).rejects.toThrow();
      expect(await readFile(first.metadataPath, 'utf8')).toBe(corruptedMetadata);
    }
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
