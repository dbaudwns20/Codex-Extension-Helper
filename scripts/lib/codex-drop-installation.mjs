import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { PATCH_VERSION, patchBundleSource } from './codex-drop-source.mjs';

const VERSION_COMPARATOR = new Intl.Collator('en', { numeric: true });

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
  return {
    backupPath: `${bundlePath}.codex-explorer-drop-chips.original`,
    metadataPath: `${bundlePath}.codex-explorer-drop-chips.json`,
  };
}

function temporaryPath(filePath) {
  return `${filePath}.tmp-${process.pid}-${randomUUID()}`;
}

function metadataFor(target, paths, originalSha256, patchedSha256) {
  return {
    patchVersion: PATCH_VERSION,
    extensionVersion: target.extensionVersion,
    bundlePath: target.bundlePath,
    backupPath: paths.backupPath,
    originalSha256,
    patchedSha256,
  };
}

function assertMetadataShape(metadata, target, paths) {
  if (
    metadata === null
    || typeof metadata !== 'object'
    || !Number.isInteger(metadata.patchVersion)
    || metadata.patchVersion < 1
    || metadata.patchVersion > PATCH_VERSION
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

async function readMetadata(target, paths) {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(paths.metadataPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Codex drop patch metadata is invalid');
    throw error;
  }
  assertMetadataShape(metadata, target, paths);
  return metadata;
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
  const source = await readFile(target.bundlePath, 'utf8');
  const transformed = patchBundleSource(source);
  const paths = patchPaths(target.bundlePath);

  if (transformed.status === 'already-patched') {
    const metadata = await readMetadata(target, paths);
    if (metadata.patchVersion !== PATCH_VERSION) throw new Error('Codex drop patch metadata is invalid');
    if (sha256(source) !== metadata.patchedSha256) throw new Error('Current bundle hash does not match patch metadata');
    if (sha256(await readFile(paths.backupPath)) !== metadata.originalSha256) throw new Error('Backup hash does not match patch metadata');
    return { status: 'already-patched', ...target, ...paths };
  }

  const originalSha256 = sha256(source);
  const patchedSha256 = sha256(transformed.source);
  const existingBackup = await fileExists(paths.backupPath);
  if (existingBackup) {
    const metadata = await readMetadata(target, paths);
    if (
      metadata.originalSha256 !== originalSha256
      || (metadata.patchVersion === PATCH_VERSION && metadata.patchedSha256 !== patchedSha256)
      || sha256(await readFile(paths.backupPath)) !== originalSha256
    ) {
      throw new Error('Existing Codex drop backup does not match the current original bundle');
    }
  } else if (await fileExists(paths.metadataPath)) {
    throw new Error('Existing Codex drop patch metadata has no backup');
  } else {
    await writeFile(paths.backupPath, source, { flag: 'wx' });
  }

  const metadata = metadataFor(target, paths, originalSha256, patchedSha256);
  let metadataTempPath;
  let bundleTempPath;
  try {
    metadataTempPath = await writeTemporary(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    bundleTempPath = await writeTemporary(target.bundlePath, transformed.source);
    await rename(metadataTempPath, paths.metadataPath);
    metadataTempPath = undefined;
    await rename(bundleTempPath, target.bundlePath);
    bundleTempPath = undefined;
  } catch (error) {
    throw new Error(`Could not install Codex drop patch; original bundle remains intact and backup is at ${paths.backupPath}: ${error.message}`);
  } finally {
    await Promise.all([
      metadataTempPath === undefined ? undefined : rm(metadataTempPath, { force: true }),
      bundleTempPath === undefined ? undefined : rm(bundleTempPath, { force: true }),
    ]);
  }
  return { status: 'patched', ...target, ...paths };
}

export async function restoreCodexDropPatch(options = {}) {
  const target = await findRestoreTarget(options);
  const paths = patchPaths(target.bundlePath);
  const metadata = await readMetadata(target, paths);
  const currentSource = await readFile(target.bundlePath);
  const currentSha256 = sha256(currentSource);
  if (currentSha256 !== metadata.patchedSha256 && currentSha256 !== metadata.originalSha256) {
    throw new Error('Current bundle hash does not match patch metadata');
  }
  const originalSource = await readFile(paths.backupPath);
  if (sha256(originalSource) !== metadata.originalSha256) throw new Error('Backup hash does not match patch metadata');
  if (currentSha256 === metadata.originalSha256) return { status: 'already-restored', ...target, ...paths };

  const bundleTempPath = await writeTemporary(target.bundlePath, originalSource);
  try {
    await rename(bundleTempPath, target.bundlePath);
  } catch (error) {
    throw new Error(`Could not restore Codex drop patch: ${error.message}`);
  } finally {
    await rm(bundleTempPath, { force: true });
  }
  return { status: 'restored', ...target, ...paths };
}
