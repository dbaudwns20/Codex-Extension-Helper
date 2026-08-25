import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { PATCH_VERSION, patchBundleSource } from './codex-drop-source.mjs';
import {
  BOOTSTRAP_ASSET_NAME,
  CACHE_BOOTSTRAP_VERSION,
  createBootstrapSource,
  patchIndexSource,
} from './codex-webview-cache-source.mjs';

const VERSION_COMPARATOR = new Intl.Collator('en', { numeric: true });
const METADATA_SCHEMA_VERSION = 2;

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

function assertSchema2MetadataShape(metadata, target, paths) {
  if (
    metadata === null
    || typeof metadata !== 'object'
    || metadata.metadataSchemaVersion !== METADATA_SCHEMA_VERSION
    || metadata.patchVersion !== PATCH_VERSION
    || metadata.cacheBootstrapVersion !== CACHE_BOOTSTRAP_VERSION
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
    || metadata.bootstrapPath !== paths.bootstrapPath
    || typeof metadata.bootstrapSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(metadata.bootstrapSha256)
    || typeof metadata.entrySource !== 'string'
  ) {
    throw new Error('Codex drop patch metadata is invalid');
  }
}

function assertLegacyMetadataShape(metadata, target, paths) {
  if (
    metadata === null
    || typeof metadata !== 'object'
    || 'metadataSchemaVersion' in metadata
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
  if (
    metadata === null
    || typeof metadata !== 'object'
    || metadata.extensionVersion !== target.extensionVersion
    || metadata.bundlePath !== target.bundlePath
    || metadata.backupPath !== paths.backupPath
    || typeof metadata.originalSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(metadata.originalSha256)
  ) {
    throw new Error('Codex drop patch metadata is invalid');
  }

  if (
    metadata.metadataSchemaVersion === METADATA_SCHEMA_VERSION
    || 'indexPath' in metadata
    || 'indexBackupPath' in metadata
    || 'originalIndexSha256' in metadata
    || 'bootstrapPath' in metadata
  ) {
    assertSchema2MetadataShape(metadata, target, paths);
  }
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
    if (sha256(currentSource) === expectedSha256) await rm(bootstrapPath, { force: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}

async function restoreFromBackup(targetPath, source) {
  const tempPath = await writeTemporary(targetPath, source);
  try {
    await rename(tempPath, targetPath);
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
  const createdBackups = [];
  try {
    tempPaths.bootstrap = await writeTemporary(paths.bootstrapPath, bootstrapSource);
    tempPaths.index = await writeTemporary(paths.indexPath, index.patchedSource);
    if (bundle.patchedSource !== undefined) tempPaths.bundle = await writeTemporary(target.bundlePath, bundle.patchedSource);
    tempPaths.metadata = await writeTemporary(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    if (!backups.bundleExists) {
      await writeFile(paths.backupPath, bundle.originalSource, { flag: 'wx' });
      createdBackups.push(paths.backupPath);
    }
    if (!backups.indexExists) {
      await writeFile(paths.indexBackupPath, index.originalSource, { flag: 'wx' });
      createdBackups.push(paths.indexBackupPath);
    }

    const renamed = [];
    try {
      await rename(tempPaths.bootstrap, paths.bootstrapPath);
      tempPaths.bootstrap = undefined;
      renamed.push('bootstrap');

      await rename(tempPaths.index, paths.indexPath);
      tempPaths.index = undefined;
      renamed.push('index');

      if (tempPaths.bundle !== undefined) {
        await rename(tempPaths.bundle, target.bundlePath);
        tempPaths.bundle = undefined;
        renamed.push('bundle');
      }

      await rename(tempPaths.metadata, paths.metadataPath);
      tempPaths.metadata = undefined;
    } catch (error) {
      if (renamed.includes('bundle')) await restoreFromBackup(target.bundlePath, bundle.originalSource);
      if (renamed.includes('index')) await restoreFromBackup(paths.indexPath, index.originalSource);
      if (renamed.includes('bootstrap')) await removeBootstrapIfMatches(paths.bootstrapPath, metadata.bootstrapSha256);
      throw new Error(`Could not install Codex drop patch; original bundle remains intact and backup is at ${paths.backupPath}: ${error.message}`);
    }
  } catch (error) {
    if (createdBackups.length !== 0) {
      await Promise.all(createdBackups.map((filePath) => rm(filePath, { force: true })));
    }
    throw error;
  } finally {
    await Promise.all([
      tempPaths.bootstrap === undefined ? undefined : rm(tempPaths.bootstrap, { force: true }),
      tempPaths.index === undefined ? undefined : rm(tempPaths.index, { force: true }),
      tempPaths.bundle === undefined ? undefined : rm(tempPaths.bundle, { force: true }),
      tempPaths.metadata === undefined ? undefined : rm(tempPaths.metadata, { force: true }),
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

export async function applyCodexDropPatch(options = {}) {
  const target = await resolveCodexTarget(options);
  const paths = patchPaths(target.bundlePath);
  const bundleSource = await readFile(target.bundlePath, 'utf8');
  const bundleTransformed = patchBundleSource(bundleSource);
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
  const metadataExists = await fileExists(paths.metadataPath);

  if (backups.bundleExists) {
    if (!metadataExists) throw new Error('Existing Codex drop backup does not match the current original bundle');
    const metadata = await readParsedMetadata(paths);
    assertReusableMetadataShape(metadata, target, paths);
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
    status: 'patched',
  });
}

export async function restoreCodexDropPatch(options = {}) {
  const target = await findRestoreTarget(options);
  const paths = patchPaths(target.bundlePath);
  const metadata = await readParsedMetadata(paths);
  if (metadata?.metadataSchemaVersion === undefined) {
    assertLegacyMetadataShape(metadata, target, paths);
    return restoreLegacyBundlePatch(target, paths, metadata);
  }
  assertSchema2MetadataShape(metadata, target, paths);
  return restoreSchema2Patch(target, paths, metadata);
}

async function restoreLegacyBundlePatch(target, paths, metadata) {
  const currentBundleSource = await readFile(target.bundlePath);
  const currentBundleSha256 = sha256(currentBundleSource);
  assertCurrentMatches(currentBundleSha256, metadata.originalSha256, metadata.patchedSha256, 'bundle');
  const originalBundleSource = await readFile(paths.backupPath);
  if (sha256(originalBundleSource) !== metadata.originalSha256) throw new Error('Backup hash does not match patch metadata');
  if (currentBundleSha256 === metadata.originalSha256) return { status: 'already-restored', ...target, ...paths };

  const bundleTempPath = await writeTemporary(target.bundlePath, originalBundleSource);
  try {
    await rename(bundleTempPath, target.bundlePath);
  } catch (error) {
    throw new Error(`Could not restore Codex drop patch: ${error.message}`);
  } finally {
    await rm(bundleTempPath, { force: true });
  }
  return { status: 'restored', ...target, ...paths };
}

async function restoreSchema2Patch(target, paths, metadata) {
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
  try {
    await rename(indexTempPath, paths.indexPath);
    try {
      await rename(bundleTempPath, target.bundlePath);
    } catch (error) {
      await restoreFromBackup(paths.indexPath, currentIndexSource);
      throw error;
    }
    await removeBootstrapIfMatches(paths.bootstrapPath, metadata.bootstrapSha256);
  } catch (error) {
    throw new Error(`Could not restore Codex drop patch: ${error.message}`);
  } finally {
    await Promise.all([
      rm(bundleTempPath, { force: true }),
      rm(indexTempPath, { force: true }),
    ]);
  }
  return { status: 'restored', ...target, ...paths };
}
