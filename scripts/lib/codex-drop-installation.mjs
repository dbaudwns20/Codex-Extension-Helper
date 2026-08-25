import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { PATCH_VERSION, patchBundleSource } from './codex-drop-source.mjs';
import {
  BOOTSTRAP_ASSET_NAME,
  CACHE_BOOTSTRAP_VERSION,
  createBootstrapSource,
  matchesCacheBootstrapV1Artifacts,
  patchIndexSource,
} from './codex-webview-cache-source.mjs';

const VERSION_COMPARATOR = new Intl.Collator('en', { numeric: true });
const METADATA_SCHEMA_VERSION = 2;
const LEGACY_METADATA_KEYS = [
  'backupPath',
  'bundlePath',
  'extensionVersion',
  'originalSha256',
  'patchedSha256',
  'patchVersion',
].sort();
const SCHEMA2_METADATA_KEYS = [
  'backupPath',
  'bootstrapPath',
  'bootstrapSha256',
  'bundlePath',
  'cacheBootstrapVersion',
  'entrySource',
  'extensionVersion',
  'indexBackupPath',
  'indexPath',
  'metadataSchemaVersion',
  'originalIndexSha256',
  'originalSha256',
  'patchedIndexSha256',
  'patchedSha256',
  'patchVersion',
].sort();

function defaultRoots() {
  return [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
  ];
}

async function readPackage(extensionDir) {
  try {
    return JSON.parse(await readFile(path.join(extensionDir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

async function asInstallation(extensionDir) {
  const manifest = await readPackage(extensionDir);
  const directoryName = path.basename(extensionDir);
  if (manifest === undefined || (manifest.name !== 'chatgpt' && !directoryName.startsWith('openai.chatgpt-'))) {
    return undefined;
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') return undefined;
  return { extensionDir, extensionVersion: manifest.version };
}

export async function discoverCodexInstallations(options = {}) {
  if (options.extensionDir !== undefined) {
    const installation = await asInstallation(options.extensionDir);
    return installation === undefined ? [] : [installation];
  }

  const installations = [];
  for (const root of options.roots ?? defaultRoots()) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const installation = await asInstallation(path.join(root, entry.name));
      if (installation !== undefined) installations.push(installation);
    }
  }
  return installations.sort((left, right) => VERSION_COMPARATOR.compare(left.extensionVersion, right.extensionVersion));
}

async function compatibleBundlePaths(extensionDir) {
  const assetsDir = path.join(extensionDir, 'webview', 'assets');
  let entries;
  try {
    entries = await readdir(assetsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const bundlePaths = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^app-initial-.*\.js$/u.test(entry.name)) continue;
    const bundlePath = path.join(assetsDir, entry.name);
    try {
      patchBundleSource(await readFile(bundlePath, 'utf8'));
      bundlePaths.push(bundlePath);
    } catch {
      // An unrecognized bundle must never be selected.
    }
  }
  return bundlePaths;
}

export async function resolveCodexTarget(options = {}) {
  const installations = await discoverCodexInstallations(options);
  if (installations.length === 0) throw new Error('No compatible Codex installation found');

  const ordered = [...installations].sort((left, right) => VERSION_COMPARATOR.compare(right.extensionVersion, left.extensionVersion));
  const installation = ordered[0];
  const bundlePaths = await compatibleBundlePaths(installation.extensionDir);
  if (bundlePaths.length === 1) return { ...installation, bundlePath: bundlePaths[0] };
  if (bundlePaths.length > 1) throw new Error('Expected exactly one compatible Codex bundle');
  throw new Error('No compatible Codex bundle found');
}

export function sha256(textOrBuffer) {
  return createHash('sha256').update(textOrBuffer).digest('hex');
}

function patchPaths(bundlePath) {
  const assetsDir = path.dirname(bundlePath);
  const webviewDir = path.dirname(assetsDir);
  const indexPath = path.join(webviewDir, 'index.html');
  return {
    backupPath: `${bundlePath}.codex-explorer-drop-chips.original`,
    metadataPath: `${bundlePath}.codex-explorer-drop-chips.json`,
    indexPath,
    indexBackupPath: `${indexPath}.codex-explorer-drop-chips.original`,
    bootstrapPath: path.join(assetsDir, BOOTSTRAP_ASSET_NAME),
  };
}

function bootstrapPathForVersion(bundlePath, version) {
  return path.join(path.dirname(bundlePath), `codex-explorer-drop-cache-bootstrap-v${version}.js`);
}

function temporaryPath(filePath) {
  return `${filePath}.tmp-${process.pid}-${randomUUID()}`;
}

function metadataFor(target, paths, hashes) {
  return {
    metadataSchemaVersion: METADATA_SCHEMA_VERSION,
    patchVersion: PATCH_VERSION,
    cacheBootstrapVersion: CACHE_BOOTSTRAP_VERSION,
    extensionVersion: target.extensionVersion,
    bundlePath: target.bundlePath,
    backupPath: paths.backupPath,
    originalSha256: hashes.originalSha256,
    patchedSha256: hashes.patchedSha256,
    indexPath: paths.indexPath,
    indexBackupPath: paths.indexBackupPath,
    originalIndexSha256: hashes.originalIndexSha256,
    patchedIndexSha256: hashes.patchedIndexSha256,
    bootstrapPath: paths.bootstrapPath,
    bootstrapSha256: hashes.bootstrapSha256,
    entrySource: hashes.entrySource,
  };
}

function assertSchema2MetadataShape(metadata, target, paths, bootstrapVersion = CACHE_BOOTSTRAP_VERSION) {
  if (
    metadata === null
    || typeof metadata !== 'object'
    || Object.keys(metadata).sort().join('\0') !== SCHEMA2_METADATA_KEYS.join('\0')
    || metadata.metadataSchemaVersion !== METADATA_SCHEMA_VERSION
    || metadata.patchVersion !== PATCH_VERSION
    || metadata.cacheBootstrapVersion !== bootstrapVersion
    || metadata.extensionVersion !== target.extensionVersion
    || metadata.bundlePath !== target.bundlePath
    || metadata.backupPath !== paths.backupPath
    || typeof metadata.originalSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(metadata.originalSha256)
    || typeof metadata.patchedSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(metadata.patchedSha256)
    || metadata.indexPath !== paths.indexPath
    || metadata.indexBackupPath !== paths.indexBackupPath
    || typeof metadata.originalIndexSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(metadata.originalIndexSha256)
    || typeof metadata.patchedIndexSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(metadata.patchedIndexSha256)
    || metadata.bootstrapPath !== bootstrapPathForVersion(target.bundlePath, bootstrapVersion)
    || typeof metadata.bootstrapSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(metadata.bootstrapSha256)
    || typeof metadata.entrySource !== 'string'
    || !/^\.\/assets\/index-[^"]+\.js$/u.test(metadata.entrySource)
  ) {
    throw new Error('Codex drop patch metadata is invalid');
  }
}

function assertSupportedSchema2MetadataShape(metadata, target, paths) {
  if (metadata?.cacheBootstrapVersion !== 1 && metadata?.cacheBootstrapVersion !== CACHE_BOOTSTRAP_VERSION) {
    throw new Error('Codex drop patch metadata is invalid');
  }
  assertSchema2MetadataShape(metadata, target, paths, metadata.cacheBootstrapVersion);
}

function assertLegacyMetadataShape(metadata, target, paths) {
  if (
    metadata === null
    || typeof metadata !== 'object'
    || 'metadataSchemaVersion' in metadata
    || Object.keys(metadata).sort().join('\0') !== LEGACY_METADATA_KEYS.join('\0')
    || metadata.patchVersion !== PATCH_VERSION
    || metadata.extensionVersion !== target.extensionVersion
    || metadata.bundlePath !== target.bundlePath
    || metadata.backupPath !== paths.backupPath
    || typeof metadata.originalSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(metadata.originalSha256)
    || typeof metadata.patchedSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(metadata.patchedSha256)
  ) {
    throw new Error('Codex drop patch metadata is invalid');
  }
}

function assertReusableMetadataShape(metadata, target, paths) {
  if (metadata?.metadataSchemaVersion === undefined) assertLegacyMetadataShape(metadata, target, paths);
  else assertSupportedSchema2MetadataShape(metadata, target, paths);
}

async function readParsedMetadata(paths) {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(paths.metadataPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Codex drop patch metadata is invalid');
    throw error;
  }
  return metadata;
}

async function readSchema2Metadata(target, paths) {
  const metadata = await readParsedMetadata(paths);
  assertSchema2MetadataShape(metadata, target, paths);
  return metadata;
}

function assertCurrentMatches(currentSha256, originalSha256, patchedSha256, label) {
  if (currentSha256 !== originalSha256 && currentSha256 !== patchedSha256) {
    throw new Error(`Current ${label} hash does not match patch metadata`);
  }
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeTemporary(filePath, data) {
  const tempPath = temporaryPath(filePath);
  await writeFile(tempPath, data, { flag: 'wx' });
  return tempPath;
}

async function removeBootstrapIfMatches(bootstrapPath, expectedSha256) {
  try {
    const currentSource = await readFile(bootstrapPath);
    if (sha256(currentSource) !== expectedSha256) return false;
    await rm(bootstrapPath, { force: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function fileOperationsFor(options) {
  return {
    rename: options?.__testFileOperations?.rename ?? rename,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function attemptRollbackActions(actions) {
  const results = await Promise.allSettled(actions.map(({ run }) => Promise.resolve().then(run)));
  return results.flatMap((result, index) => (
    result.status === 'rejected'
      ? [{ label: actions[index].label, message: errorMessage(result.reason) }]
      : []
  ));
}

function transactionError(prefix, error, rollbackFailures) {
  const rollbackSuffix = rollbackFailures.length === 0
    ? ''
    : `; rollback failures: ${rollbackFailures.map(({ label, message }) => `${label}: ${message}`).join('; ')}`;
  return new Error(`${prefix}: ${errorMessage(error)}${rollbackSuffix}`);
}

async function restoreFromBackup(targetPath, source, operations) {
  const tempPath = await writeTemporary(targetPath, source);
  try {
    await operations.rename(tempPath, targetPath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function installSchema2Patch({
  target,
  paths,
  bundle,
  index,
  bootstrapSource,
  backups,
  status,
  obsoleteBootstrap,
  operations = fileOperationsFor(),
}) {
  const metadata = metadataFor(target, paths, {
    originalSha256: bundle.originalSha256,
    patchedSha256: bundle.patchedSha256,
    originalIndexSha256: index.originalSha256,
    patchedIndexSha256: index.patchedSha256,
    bootstrapSha256: sha256(bootstrapSource),
    entrySource: index.entrySource,
  });
  const tempPaths = {};
  let preserveObsoleteBootstrapTemp = false;
  try {
    tempPaths.bootstrap = await writeTemporary(paths.bootstrapPath, bootstrapSource);
    tempPaths.index = await writeTemporary(paths.indexPath, index.patchedSource);
    if (bundle.patchedSource !== undefined) tempPaths.bundle = await writeTemporary(target.bundlePath, bundle.patchedSource);
    tempPaths.metadata = await writeTemporary(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    if (!backups.bundleExists) {
      await writeFile(paths.backupPath, bundle.originalSource, { flag: 'wx' });
    }
    if (!backups.indexExists) {
      await writeFile(paths.indexBackupPath, index.originalSource, { flag: 'wx' });
    }

    const renamed = [];
    try {
      await operations.rename(tempPaths.bootstrap, paths.bootstrapPath);
      tempPaths.bootstrap = undefined;
      renamed.push('bootstrap');

      await operations.rename(tempPaths.index, paths.indexPath);
      tempPaths.index = undefined;
      renamed.push('index');

      if (tempPaths.bundle !== undefined) {
        await operations.rename(tempPaths.bundle, target.bundlePath);
        tempPaths.bundle = undefined;
        renamed.push('bundle');
      }

      if (obsoleteBootstrap !== undefined) {
        if (sha256(await readFile(obsoleteBootstrap.path)) !== obsoleteBootstrap.sha256) {
          throw new Error('Obsolete bootstrap hash changed during installation');
        }
        tempPaths.obsoleteBootstrap = temporaryPath(obsoleteBootstrap.path);
        await operations.rename(obsoleteBootstrap.path, tempPaths.obsoleteBootstrap);
        renamed.push('obsolete-bootstrap');
      }

      await operations.rename(tempPaths.metadata, paths.metadataPath);
      tempPaths.metadata = undefined;
      if (tempPaths.obsoleteBootstrap !== undefined) {
        try {
          await rm(tempPaths.obsoleteBootstrap, { force: true });
          tempPaths.obsoleteBootstrap = undefined;
        } catch {
          // The v1 path is already retired and v2 metadata is committed; cleanup retries below.
        }
      }
    } catch (error) {
      const rollbackActions = [];
      if (renamed.includes('bundle')) {
        rollbackActions.push({
          label: 'bundle',
          run: () => restoreFromBackup(target.bundlePath, bundle.rollbackSource ?? bundle.originalSource, operations),
        });
      }
      if (renamed.includes('index')) {
        rollbackActions.push({
          label: 'index',
          run: () => restoreFromBackup(paths.indexPath, index.rollbackSource ?? index.originalSource, operations),
        });
      }
      if (renamed.includes('bootstrap')) {
        rollbackActions.push({
          label: 'bootstrap',
          run: () => removeBootstrapIfMatches(paths.bootstrapPath, metadata.bootstrapSha256),
        });
      }
      if (renamed.includes('obsolete-bootstrap') && tempPaths.obsoleteBootstrap !== undefined) {
        rollbackActions.push({
          label: `obsolete bootstrap preserved at ${tempPaths.obsoleteBootstrap}`,
          run: async () => {
            await operations.rename(tempPaths.obsoleteBootstrap, obsoleteBootstrap.path);
            tempPaths.obsoleteBootstrap = undefined;
          },
        });
      }
      const rollbackFailures = await attemptRollbackActions(rollbackActions);
      preserveObsoleteBootstrapTemp = rollbackFailures.some(({ label }) => label.startsWith('obsolete bootstrap preserved at '));
      throw transactionError(
        `Could not install Codex drop patch; recovery backups are ${paths.backupPath} and ${paths.indexBackupPath}`,
        error,
        rollbackFailures,
      );
    }
  } finally {
    await Promise.allSettled([
      tempPaths.bootstrap === undefined ? undefined : rm(tempPaths.bootstrap, { force: true }),
      tempPaths.index === undefined ? undefined : rm(tempPaths.index, { force: true }),
      tempPaths.bundle === undefined ? undefined : rm(tempPaths.bundle, { force: true }),
      tempPaths.metadata === undefined ? undefined : rm(tempPaths.metadata, { force: true }),
      tempPaths.obsoleteBootstrap === undefined || preserveObsoleteBootstrapTemp
        ? undefined
        : rm(tempPaths.obsoleteBootstrap, { force: true }),
    ]);
  }

  return { status, ...target, ...paths };
}

async function findRestoreTarget(options) {
  const installations = await discoverCodexInstallations(options);
  if (installations.length === 0) throw new Error('No compatible Codex installation found');
  const ordered = [...installations].sort((left, right) => VERSION_COMPARATOR.compare(right.extensionVersion, left.extensionVersion));
  const installation = ordered[0];
  const assetsDir = path.join(installation.extensionDir, 'webview', 'assets');
  let entries;
  try {
    entries = await readdir(assetsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('No Codex drop patch metadata found');
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^app-initial-.*\.js$/u.test(entry.name)) continue;
    const bundlePath = path.join(assetsDir, entry.name);
    if (await fileExists(patchPaths(bundlePath).metadataPath)) candidates.push(bundlePath);
  }
  if (candidates.length === 1) return { ...installation, bundlePath: candidates[0] };
  if (candidates.length > 1) throw new Error('Expected exactly one Codex bundle with patch metadata');
  throw new Error('No Codex drop patch metadata found');
}

async function migrateSchema2V1Patch(target, paths, bundleSource, metadata, operations) {
  assertSchema2MetadataShape(metadata, target, paths, 1);
  if (sha256(bundleSource) !== metadata.patchedSha256) throw new Error('Current bundle hash does not match patch metadata');
  const originalBundleSource = await readFile(paths.backupPath, 'utf8');
  if (sha256(originalBundleSource) !== metadata.originalSha256) throw new Error('Backup hash does not match patch metadata');
  const expectedBundle = patchBundleSource(originalBundleSource);
  if (expectedBundle.status !== 'patched' || sha256(expectedBundle.source) !== metadata.patchedSha256) {
    throw new Error('Codex drop patch metadata is invalid');
  }

  const currentIndexSource = await readFile(paths.indexPath, 'utf8');
  if (sha256(currentIndexSource) !== metadata.patchedIndexSha256) throw new Error('Current index hash does not match patch metadata');
  const originalIndexSource = await readFile(paths.indexBackupPath, 'utf8');
  if (sha256(originalIndexSource) !== metadata.originalIndexSha256) throw new Error('Index backup hash does not match patch metadata');
  const currentBootstrapSource = await readFile(metadata.bootstrapPath, 'utf8');
  if (sha256(currentBootstrapSource) !== metadata.bootstrapSha256) throw new Error('Current bootstrap hash does not match patch metadata');
  if (!matchesCacheBootstrapV1Artifacts({
    originalIndexSource,
    patchedIndexSource: currentIndexSource,
    bootstrapSource: currentBootstrapSource,
    entrySource: metadata.entrySource,
  })) {
    throw new Error('Codex drop patch metadata is invalid');
  }
  if (await fileExists(paths.bootstrapPath)) throw new Error('Current install contains unexpected bootstrap-v2 state');

  const indexTransformed = patchIndexSource(originalIndexSource);
  if (indexTransformed.status !== 'patched' || indexTransformed.entrySource !== metadata.entrySource) {
    throw new Error('Codex drop patch metadata is invalid');
  }
  return installSchema2Patch({
    target,
    paths,
    bundle: {
      originalSource: originalBundleSource,
      originalSha256: metadata.originalSha256,
      patchedSource: undefined,
      patchedSha256: metadata.patchedSha256,
    },
    index: {
      originalSource: originalIndexSource,
      originalSha256: metadata.originalIndexSha256,
      patchedSource: indexTransformed.source,
      patchedSha256: sha256(indexTransformed.source),
      entrySource: indexTransformed.entrySource,
      rollbackSource: currentIndexSource,
    },
    bootstrapSource: createBootstrapSource(indexTransformed.entrySource),
    backups: {
      bundleExists: true,
      indexExists: true,
    },
    obsoleteBootstrap: {
      path: metadata.bootstrapPath,
      sha256: metadata.bootstrapSha256,
    },
    operations,
    status: 'migrated',
  });
}

export async function applyCodexDropPatch(options = {}) {
  const operations = fileOperationsFor(options);
  const target = await resolveCodexTarget(options);
  const paths = patchPaths(target.bundlePath);
  const bundleSource = await readFile(target.bundlePath, 'utf8');
  const bundleTransformed = patchBundleSource(bundleSource);
  const metadataExists = await fileExists(paths.metadataPath);
  if (bundleTransformed.status === 'already-patched' && metadataExists) {
    const metadata = await readParsedMetadata(paths);
    if (metadata?.metadataSchemaVersion === METADATA_SCHEMA_VERSION && metadata.cacheBootstrapVersion === 1) {
      return migrateSchema2V1Patch(target, paths, bundleSource, metadata, operations);
    }
  }
  const indexSource = await readFile(paths.indexPath, 'utf8');
  const indexTransformed = patchIndexSource(indexSource);
  const indexBackupExists = await fileExists(paths.indexBackupPath);
  const bootstrapExists = await fileExists(paths.bootstrapPath);

  if (bundleTransformed.status === 'already-patched') {
    const metadata = await readParsedMetadata(paths);
    try {
      assertSchema2MetadataShape(metadata, target, paths);
    } catch {
      assertLegacyMetadataShape(metadata, target, paths);
      if (sha256(bundleSource) !== metadata.patchedSha256) throw new Error('Current bundle hash does not match patch metadata');
      const originalBundleSource = await readFile(paths.backupPath, 'utf8');
      if (sha256(originalBundleSource) !== metadata.originalSha256) throw new Error('Backup hash does not match patch metadata');
      if (indexTransformed.status !== 'patched' || indexBackupExists || bootstrapExists) {
        throw new Error('Current index is already patched without valid schema-2 metadata');
      }
      return installSchema2Patch({
        target,
        paths,
        bundle: {
          originalSource: originalBundleSource,
          originalSha256: metadata.originalSha256,
          patchedSource: undefined,
          patchedSha256: metadata.patchedSha256,
        },
        index: {
          originalSource: indexSource,
          originalSha256: sha256(indexSource),
          patchedSource: indexTransformed.source,
          patchedSha256: sha256(indexTransformed.source),
          entrySource: indexTransformed.entrySource,
        },
        bootstrapSource: createBootstrapSource(indexTransformed.entrySource),
        backups: {
          bundleExists: true,
          indexExists: false,
        },
        operations,
        status: 'migrated',
      });
    }
    if (sha256(bundleSource) !== metadata.patchedSha256) throw new Error('Current bundle hash does not match patch metadata');
    if (sha256(await readFile(paths.backupPath)) !== metadata.originalSha256) throw new Error('Backup hash does not match patch metadata');
    if (sha256(indexSource) !== metadata.patchedIndexSha256) throw new Error('Current index hash does not match patch metadata');
    if (sha256(await readFile(paths.indexBackupPath)) !== metadata.originalIndexSha256) throw new Error('Index backup hash does not match patch metadata');
    if (sha256(await readFile(paths.bootstrapPath)) !== metadata.bootstrapSha256) throw new Error('Current bootstrap hash does not match patch metadata');
    return { status: 'already-patched', ...target, ...paths };
  }

  if (indexTransformed.status !== 'patched') throw new Error('Current index is already patched without valid schema-2 metadata');

  const bundle = {
    originalSource: bundleSource,
    originalSha256: sha256(bundleSource),
    patchedSource: bundleTransformed.source,
    patchedSha256: sha256(bundleTransformed.source),
  };
  const index = {
    originalSource: indexSource,
    originalSha256: sha256(indexSource),
    patchedSource: indexTransformed.source,
    patchedSha256: sha256(indexTransformed.source),
    entrySource: indexTransformed.entrySource,
  };
  const bootstrapSource = createBootstrapSource(index.entrySource);
  const backups = {
    bundleExists: await fileExists(paths.backupPath),
    indexExists: indexBackupExists,
  };
  if (backups.bundleExists) {
    if (!metadataExists) throw new Error('Existing Codex drop backup does not match the current original bundle');
    const metadata = await readParsedMetadata(paths);
    assertReusableMetadataShape(metadata, target, paths);
    if (metadata.metadataSchemaVersion === undefined && metadata.patchedSha256 !== bundle.patchedSha256) {
      throw new Error('Codex drop patch metadata is invalid');
    }
    if (
      metadata.originalSha256 !== bundle.originalSha256
      || sha256(await readFile(paths.backupPath)) !== bundle.originalSha256
    ) {
      throw new Error('Existing Codex drop backup does not match the current original bundle');
    }
    if (metadata.metadataSchemaVersion === METADATA_SCHEMA_VERSION || backups.indexExists || bootstrapExists) {
      if (!backups.indexExists) throw new Error('Codex drop patch metadata is invalid');
      if (
        metadata.originalIndexSha256 !== index.originalSha256
        || sha256(await readFile(paths.indexBackupPath)) !== index.originalSha256
      ) {
        throw new Error('Existing Codex drop backup does not match the current original bundle');
      }
      if (metadata.metadataSchemaVersion === METADATA_SCHEMA_VERSION) {
        if (
          metadata.patchedSha256 !== bundle.patchedSha256
          || metadata.patchedIndexSha256 !== index.patchedSha256
          || metadata.bootstrapSha256 !== sha256(bootstrapSource)
          || metadata.entrySource !== index.entrySource
        ) {
          throw new Error('Codex drop patch metadata is invalid');
        }
      }
      if (bootstrapExists) throw new Error('Current index is already patched without valid schema-2 metadata');
    }
  } else if (metadataExists) {
    throw new Error('Existing Codex drop patch metadata has no backup');
  } else if (backups.indexExists || bootstrapExists) {
    throw new Error('Current index is already patched without valid schema-2 metadata');
  }

  return installSchema2Patch({
    target,
    paths,
    bundle,
    index,
    bootstrapSource,
    backups,
    operations,
    status: 'patched',
  });
}

export async function restoreCodexDropPatch(options = {}) {
  const operations = fileOperationsFor(options);
  const target = await findRestoreTarget(options);
  const paths = patchPaths(target.bundlePath);
  const metadata = await readParsedMetadata(paths);
  if (metadata?.metadataSchemaVersion === undefined) {
    assertLegacyMetadataShape(metadata, target, paths);
    return restoreLegacyBundlePatch(target, paths, metadata, operations);
  }
  assertSupportedSchema2MetadataShape(metadata, target, paths);
  const schemaPaths = {
    ...paths,
    bootstrapPath: metadata.bootstrapPath,
  };
  return restoreSchema2Patch(target, schemaPaths, metadata, operations);
}

async function restoreLegacyBundlePatch(target, paths, metadata, operations) {
  const currentBundleSource = await readFile(target.bundlePath);
  const currentBundleSha256 = sha256(currentBundleSource);
  assertCurrentMatches(currentBundleSha256, metadata.originalSha256, metadata.patchedSha256, 'bundle');
  const originalBundleSource = await readFile(paths.backupPath);
  if (sha256(originalBundleSource) !== metadata.originalSha256) throw new Error('Backup hash does not match patch metadata');
  if (currentBundleSha256 === metadata.originalSha256) {
    return {
      status: 'already-restored',
      ...target,
      backupPath: paths.backupPath,
      metadataPath: paths.metadataPath,
    };
  }

  const bundleTempPath = await writeTemporary(target.bundlePath, originalBundleSource);
  try {
    await operations.rename(bundleTempPath, target.bundlePath);
  } catch (error) {
    throw new Error(`Could not restore Codex drop patch: ${error.message}`);
  } finally {
    await rm(bundleTempPath, { force: true });
  }
  return {
    status: 'restored',
    ...target,
    backupPath: paths.backupPath,
    metadataPath: paths.metadataPath,
  };
}

async function restoreSchema2Patch(target, paths, metadata, operations) {
  const currentBundleSource = await readFile(target.bundlePath);
  const currentBundleSha256 = sha256(currentBundleSource);
  assertCurrentMatches(currentBundleSha256, metadata.originalSha256, metadata.patchedSha256, 'bundle');
  const originalBundleSource = await readFile(paths.backupPath);
  if (sha256(originalBundleSource) !== metadata.originalSha256) throw new Error('Backup hash does not match patch metadata');
  const currentIndexSource = await readFile(paths.indexPath, 'utf8');
  const currentIndexSha256 = sha256(currentIndexSource);
  assertCurrentMatches(currentIndexSha256, metadata.originalIndexSha256, metadata.patchedIndexSha256, 'index');
  const originalIndexSource = await readFile(paths.indexBackupPath, 'utf8');
  if (sha256(originalIndexSource) !== metadata.originalIndexSha256) throw new Error('Index backup hash does not match patch metadata');
  const bootstrapExists = await fileExists(paths.bootstrapPath);
  if (bootstrapExists) {
    if (sha256(await readFile(paths.bootstrapPath)) !== metadata.bootstrapSha256) {
      throw new Error('Bootstrap hash does not match patch metadata');
    }
  } else if (currentBundleSha256 !== metadata.originalSha256 || currentIndexSha256 !== metadata.originalIndexSha256) {
    throw new Error('Current install is partially restored without managed bootstrap');
  } else {
    return { status: 'already-restored', ...target, ...paths };
  }

  const bundleTempPath = await writeTemporary(target.bundlePath, originalBundleSource);
  const indexTempPath = await writeTemporary(paths.indexPath, originalIndexSource);
  let bundleRenamed = false;
  let indexRenamed = false;
  try {
    await operations.rename(indexTempPath, paths.indexPath);
    indexRenamed = true;
    await operations.rename(bundleTempPath, target.bundlePath);
    bundleRenamed = true;
    if (!await removeBootstrapIfMatches(paths.bootstrapPath, metadata.bootstrapSha256)) {
      throw new Error('Managed bootstrap changed during restore');
    }
  } catch (error) {
    const rollbackActions = [];
    if (bundleRenamed) {
      rollbackActions.push({
        label: 'bundle',
        run: () => restoreFromBackup(target.bundlePath, currentBundleSource, operations),
      });
    }
    if (indexRenamed) {
      rollbackActions.push({
        label: 'index',
        run: () => restoreFromBackup(paths.indexPath, currentIndexSource, operations),
      });
    }
    const rollbackFailures = await attemptRollbackActions(rollbackActions);
    throw transactionError('Could not restore Codex drop patch', error, rollbackFailures);
  } finally {
    await Promise.allSettled([
      rm(bundleTempPath, { force: true }),
      rm(indexTempPath, { force: true }),
    ]);
  }
  return { status: 'restored', ...target, ...paths };
}
