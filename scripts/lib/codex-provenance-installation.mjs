import { createHash, randomUUID } from 'node:crypto';
import {
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  PROVENANCE_BRIDGE_VERSION,
  patchCodexHostSource,
  unpatchCodexHostSource,
} from './codex-provenance-source.mjs';

const METADATA_SCHEMA_VERSION = 1;
const VERSION_COMPARATOR = new Intl.Collator('en', { numeric: true });
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const METADATA_KEYS = [
  'backupPath',
  'extensionVersion',
  'metadataSchemaVersion',
  'originalSha256',
  'patchVersion',
  'patchedSha256',
  'targetPath',
].sort();

function defaultRoots() {
  return [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
  ];
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readManifest(extensionDir) {
  try {
    return JSON.parse(await readFile(path.join(extensionDir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

async function asInstallation(extensionDir) {
  const absoluteExtensionDir = path.resolve(extensionDir);
  const manifest = await readManifest(absoluteExtensionDir);
  const directoryName = path.basename(absoluteExtensionDir);
  if (
    manifest === undefined
    || (manifest.name !== 'chatgpt' && !directoryName.startsWith('openai.chatgpt-'))
    || typeof manifest.version !== 'string'
    || manifest.version === ''
  ) {
    return undefined;
  }
  return {
    extensionDir: absoluteExtensionDir,
    extensionVersion: manifest.version,
    targetPath: path.join(absoluteExtensionDir, 'out', 'extension.js'),
  };
}

async function discoverInstallations(roots) {
  const installations = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(path.resolve(root), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const installation = await asInstallation(path.join(path.resolve(root), entry.name));
      if (installation !== undefined) installations.push(installation);
    }
  }
  return installations.sort(
    (left, right) => VERSION_COMPARATOR.compare(right.extensionVersion, left.extensionVersion),
  );
}

function validateTransformableTarget(bytes) {
  patchCodexHostSource(decodeUtf8(bytes, 'Codex provenance target'));
}

async function resolveTarget(options = {}) {
  if (options.extensionDir !== undefined) {
    const installation = await asInstallation(options.extensionDir);
    if (installation === undefined) {
      throw new Error(`No compatible Codex installation found at ${path.resolve(options.extensionDir)}`);
    }
    return installation;
  }

  const installations = await discoverInstallations(options.roots ?? defaultRoots());
  for (const installation of installations) {
    try {
      const paths = patchPaths(installation.targetPath);
      if (await fileExists(paths.backupPath) || await fileExists(paths.metadataPath)) {
        return installation;
      }
      validateTransformableTarget(await readFile(installation.targetPath));
      return installation;
    } catch {
      // Newer incompatible installations do not hide an older supported host bundle.
    }
  }
  throw new Error('No compatible Codex provenance host installation found');
}

function patchPaths(targetPath) {
  return {
    backupPath: `${targetPath}.codex-extension-helper-provenance.original`,
    metadataPath: `${targetPath}.codex-extension-helper-provenance.json`,
  };
}

function resultFor(status, target, paths) {
  return { status, ...target, ...paths };
}

function metadataFor(target, paths, originalSha256, patchedSha256) {
  return {
    metadataSchemaVersion: METADATA_SCHEMA_VERSION,
    patchVersion: PROVENANCE_BRIDGE_VERSION,
    extensionVersion: target.extensionVersion,
    targetPath: target.targetPath,
    backupPath: paths.backupPath,
    originalSha256,
    patchedSha256,
  };
}

function assertMetadata(metadata, target, paths) {
  if (
    metadata === null
    || typeof metadata !== 'object'
    || Array.isArray(metadata)
    || Object.keys(metadata).sort().join('\0') !== METADATA_KEYS.join('\0')
    || metadata.metadataSchemaVersion !== METADATA_SCHEMA_VERSION
    || metadata.patchVersion !== PROVENANCE_BRIDGE_VERSION
    || metadata.extensionVersion !== target.extensionVersion
    || metadata.targetPath !== target.targetPath
    || metadata.backupPath !== paths.backupPath
    || !path.isAbsolute(metadata.targetPath)
    || !path.isAbsolute(metadata.backupPath)
    || typeof metadata.originalSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(metadata.originalSha256)
    || typeof metadata.patchedSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(metadata.patchedSha256)
    || metadata.originalSha256 === metadata.patchedSha256
  ) {
    throw new Error('Codex provenance patch metadata is invalid');
  }
}

async function readMetadata(target, paths) {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(paths.metadataPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Codex provenance patch metadata is invalid');
    }
    throw error;
  }
  assertMetadata(metadata, target, paths);
  return metadata;
}

function expectedPatchFromBackup(backupBytes, metadata) {
  let transformed;
  try {
    transformed = patchCodexHostSource(decodeUtf8(backupBytes, 'Codex provenance backup'));
  } catch {
    throw new Error('Codex provenance patch metadata is invalid');
  }
  if (transformed.status !== 'patched') {
    throw new Error('Codex provenance patch metadata is invalid');
  }
  const patchedBytes = Buffer.from(transformed.source, 'utf8');
  const inverse = unpatchCodexHostSource(transformed.source);
  if (
    inverse.status !== 'restored'
    || !Buffer.from(inverse.source, 'utf8').equals(backupBytes)
    || sha256(patchedBytes) !== metadata.patchedSha256
  ) {
    throw new Error('Codex provenance patch metadata is invalid');
  }
  return patchedBytes;
}

async function analyze(options = {}) {
  const target = await resolveTarget(options);
  const paths = patchPaths(target.targetPath);
  const [backupExists, metadataExists] = await Promise.all([
    fileExists(paths.backupPath),
    fileExists(paths.metadataPath),
  ]);
  const targetBytes = await readFile(target.targetPath);

  if (backupExists !== metadataExists) {
    throw new Error('Codex provenance installation contains inconsistent patch artifacts');
  }

  if (!backupExists) {
    const transformed = patchCodexHostSource(decodeUtf8(targetBytes, 'Codex provenance target'));
    if (transformed.status !== 'patched') {
      throw new Error('Codex provenance installation contains inconsistent patch artifacts');
    }
    const patchedBytes = Buffer.from(transformed.source, 'utf8');
    const inverse = unpatchCodexHostSource(transformed.source);
    if (
      inverse.status !== 'restored'
      || !Buffer.from(inverse.source, 'utf8').equals(targetBytes)
    ) {
      throw new Error('Codex provenance source transform did not preserve the original bytes');
    }
    return {
      state: 'clean',
      target,
      paths,
      targetBytes,
      patchedBytes,
    };
  }

  const metadata = await readMetadata(target, paths);
  const backupBytes = await readFile(paths.backupPath);
  if (sha256(backupBytes) !== metadata.originalSha256) {
    throw new Error('Codex provenance backup hash does not match patch metadata');
  }
  const expectedPatchedBytes = expectedPatchFromBackup(backupBytes, metadata);
  const targetSha256 = sha256(targetBytes);
  if (targetSha256 === metadata.patchedSha256) {
    if (!targetBytes.equals(expectedPatchedBytes)) {
      throw new Error('Codex provenance target does not match the recorded patch');
    }
    const transformed = patchCodexHostSource(decodeUtf8(targetBytes, 'Codex provenance target'));
    if (transformed.status !== 'already-patched') {
      throw new Error('Codex provenance target marker state is invalid');
    }
    return {
      state: 'patched',
      target,
      paths,
      targetBytes,
      backupBytes,
      metadata,
      patchedBytes: expectedPatchedBytes,
    };
  }
  if (targetSha256 === metadata.originalSha256 && targetBytes.equals(backupBytes)) {
    const transformed = patchCodexHostSource(decodeUtf8(targetBytes, 'Codex provenance target'));
    if (transformed.status !== 'patched') {
      throw new Error('Codex provenance restored target marker state is invalid');
    }
    return {
      state: 'restored-pending-cleanup',
      target,
      paths,
      targetBytes,
      backupBytes,
      metadata,
      patchedBytes: expectedPatchedBytes,
    };
  }
  throw new Error('Current Codex provenance target hash does not match patch metadata');
}

async function durableWriteFile(filePath, data, options = {}) {
  const handle = await open(filePath, options.flag ?? 'w', options.mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function fileOperationsFor(options) {
  return {
    rename: options?.__testFileOperations?.rename ?? rename,
    rm: options?.__testFileOperations?.rm ?? rm,
    writeFile: options?.__testFileOperations?.writeFile ?? durableWriteFile,
  };
}

function temporaryPath(filePath) {
  return `${filePath}.tmp-${process.pid}-${randomUUID()}`;
}

async function cleanupTemporaryPaths(filePaths, operations) {
  const failures = [];
  for (const filePath of filePaths) {
    try {
      await operations.rm(filePath, { force: true });
    } catch (error) {
      failures.push(`${filePath}: ${errorMessage(error)}`);
    }
  }
  return failures;
}

async function removeNewBackup(paths, operations) {
  try {
    await operations.rm(paths.backupPath, { force: true });
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

async function atomicReplace(filePath, bytes, mode, operations, temporaryPaths) {
  const tempPath = temporaryPath(filePath);
  temporaryPaths.push(tempPath);
  await operations.writeFile(tempPath, bytes, { flag: 'wx', mode });
  await operations.rename(tempPath, filePath);
}

export async function inspectCodexProvenancePatch(options = {}) {
  const analysis = await analyze(options);
  const status = analysis.state === 'clean' ? 'not-patched' : analysis.state;
  return resultFor(status, analysis.target, analysis.paths);
}

export async function applyCodexProvenancePatch(options = {}) {
  const operations = fileOperationsFor(options);
  const analysis = await analyze(options);
  if (analysis.state === 'patched') {
    return resultFor('already-patched', analysis.target, analysis.paths);
  }
  if (analysis.state === 'restored-pending-cleanup') {
    throw new Error('Codex provenance restore cleanup is pending; re-run restore before applying');
  }

  const targetMode = (await stat(analysis.target.targetPath)).mode;
  const originalSha256 = sha256(analysis.targetBytes);
  const patchedSha256 = sha256(analysis.patchedBytes);
  const metadata = metadataFor(
    analysis.target,
    analysis.paths,
    originalSha256,
    patchedSha256,
  );
  const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  const temporaryPaths = [];
  let backupCreated = false;
  let targetInstalled = false;

  try {
    await operations.writeFile(analysis.paths.backupPath, analysis.targetBytes, {
      flag: 'wx',
      mode: targetMode,
    });
    backupCreated = true;
    if (!Buffer.from(await readFile(analysis.paths.backupPath)).equals(analysis.targetBytes)) {
      throw new Error('Codex provenance backup verification failed');
    }

    const currentBeforeInstall = await readFile(analysis.target.targetPath);
    if (!currentBeforeInstall.equals(analysis.targetBytes)) {
      throw new Error('Codex provenance target changed during installation');
    }

    const targetTempPath = temporaryPath(analysis.target.targetPath);
    const metadataTempPath = temporaryPath(analysis.paths.metadataPath);
    temporaryPaths.push(targetTempPath, metadataTempPath);
    await operations.writeFile(targetTempPath, analysis.patchedBytes, {
      flag: 'wx',
      mode: targetMode,
    });
    await operations.writeFile(metadataTempPath, metadataBytes, { flag: 'wx', mode: 0o600 });

    await operations.rename(targetTempPath, analysis.target.targetPath);
    targetInstalled = true;
    if (!Buffer.from(await readFile(analysis.target.targetPath)).equals(analysis.patchedBytes)) {
      throw new Error('Codex provenance target verification failed after installation');
    }

    await operations.rename(metadataTempPath, analysis.paths.metadataPath);
    return resultFor('patched', analysis.target, analysis.paths);
  } catch (error) {
    if (
      !backupCreated
      && error?.code !== 'EEXIST'
      && await fileExists(analysis.paths.backupPath)
    ) {
      backupCreated = true;
    }
    const metadataOnDisk = await readFile(analysis.paths.metadataPath).catch((readError) => {
      if (readError?.code === 'ENOENT') return undefined;
      throw readError;
    });
    const targetOnDisk = await readFile(analysis.target.targetPath).catch(() => undefined);
    if (
      metadataOnDisk !== undefined
      && metadataOnDisk.equals(metadataBytes)
      && targetOnDisk !== undefined
      && targetOnDisk.equals(analysis.patchedBytes)
    ) {
      await cleanupTemporaryPaths(temporaryPaths, operations);
      return resultFor('patched', analysis.target, analysis.paths);
    }

    if (metadataOnDisk !== undefined && metadataOnDisk.equals(metadataBytes)) {
      try {
        await operations.rm(analysis.paths.metadataPath);
      } catch {
        // The final error below reports the retained recovery state.
      }
    }

    let rollbackFailure;
    const currentTarget = await readFile(analysis.target.targetPath).catch(() => undefined);
    if (targetInstalled || currentTarget?.equals(analysis.patchedBytes)) {
      try {
        await atomicReplace(
          analysis.target.targetPath,
          analysis.targetBytes,
          targetMode,
          operations,
          temporaryPaths,
        );
      } catch (rollbackError) {
        rollbackFailure = errorMessage(rollbackError);
      }
    } else if (currentTarget === undefined || !currentTarget.equals(analysis.targetBytes)) {
      rollbackFailure = 'target changed to an unknown state';
    }

    const tempCleanupFailures = await cleanupTemporaryPaths(temporaryPaths, operations);
    if (rollbackFailure !== undefined) {
      throw new Error(
        `Could not install Codex provenance patch: ${errorMessage(error)}; `
        + `rollback failed: ${rollbackFailure}; original backup retained at ${analysis.paths.backupPath}`
        + (tempCleanupFailures.length === 0
          ? ''
          : `; temporary cleanup failures: ${tempCleanupFailures.join('; ')}`),
      );
    }

    const backupCleanupFailure = backupCreated
      ? await removeNewBackup(analysis.paths, operations)
      : undefined;
    if (backupCleanupFailure !== undefined) {
      throw new Error(
        `Could not install Codex provenance patch: ${errorMessage(error)}; target restored; `
        + `backup retained at ${analysis.paths.backupPath}: ${backupCleanupFailure}`,
      );
    }
    throw new Error(
      `Could not install Codex provenance patch: ${errorMessage(error)}`
      + (tempCleanupFailures.length === 0
        ? ''
        : `; temporary cleanup failures: ${tempCleanupFailures.join('; ')}`),
    );
  } finally {
    await cleanupTemporaryPaths(temporaryPaths, operations);
  }
}

async function cleanupRestoredArtifacts(analysis, operations) {
  try {
    await operations.rm(analysis.paths.metadataPath);
  } catch (error) {
    throw new Error(
      `Codex provenance target restored; recovery artifacts remain; re-run restore: ${errorMessage(error)}`,
    );
  }
  try {
    await operations.rm(analysis.paths.backupPath);
  } catch (error) {
    throw new Error(
      `Codex provenance target restored; metadata removed and backup retained at `
      + `${analysis.paths.backupPath}; manual cleanup required: ${errorMessage(error)}`,
    );
  }
}

export async function restoreCodexProvenancePatch(options = {}) {
  const operations = fileOperationsFor(options);
  const analysis = await analyze(options);
  if (analysis.state === 'clean') {
    return resultFor('already-restored', analysis.target, analysis.paths);
  }

  const wasPatched = analysis.state === 'patched';
  const temporaryPaths = [];
  if (wasPatched) {
    const targetMode = (await stat(analysis.target.targetPath)).mode;
    try {
      await atomicReplace(
        analysis.target.targetPath,
        analysis.backupBytes,
        targetMode,
        operations,
        temporaryPaths,
      );
    } catch (error) {
      const currentTarget = await readFile(analysis.target.targetPath).catch(() => undefined);
      const tempCleanupFailures = await cleanupTemporaryPaths(temporaryPaths, operations);
      if (currentTarget === undefined || !currentTarget.equals(analysis.backupBytes)) {
        throw new Error(
          `Could not restore Codex provenance patch: ${errorMessage(error)}`
          + (tempCleanupFailures.length === 0
            ? ''
            : `; temporary cleanup failures: ${tempCleanupFailures.join('; ')}`),
        );
      }
    } finally {
      await cleanupTemporaryPaths(temporaryPaths, operations);
    }

    const restoredTarget = await readFile(analysis.target.targetPath);
    if (
      !restoredTarget.equals(analysis.backupBytes)
      || sha256(restoredTarget) !== analysis.metadata.originalSha256
    ) {
      throw new Error(
        `Codex provenance target restore verification failed; original backup retained at ${analysis.paths.backupPath}`,
      );
    }
  }

  await cleanupRestoredArtifacts(analysis, operations);
  return resultFor(wasPatched ? 'restored' : 'already-restored', analysis.target, analysis.paths);
}
