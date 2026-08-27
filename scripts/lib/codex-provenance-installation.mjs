import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
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

async function assertNotSymbolicLink(filePath, label) {
  let fileStats;
  try {
    fileStats = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (fileStats.isSymbolicLink()) {
    throw new Error(`Codex provenance ${label} must not be a symbolic link`);
  }
}

async function readManifest(extensionDir) {
  let source;
  try {
    source = await readFile(path.join(extensionDir, 'package.json'), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return undefined;
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
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
    await assertNotSymbolicLink(installation.targetPath, 'target');
    return installation;
  }

  const installations = await discoverInstallations(options.roots ?? defaultRoots());
  for (const installation of installations) {
    await assertNotSymbolicLink(installation.targetPath, 'target');
    const paths = patchPaths(installation.targetPath);
    if (await fileExists(paths.backupPath) || await fileExists(paths.metadataPath)) {
      return installation;
    }
    const source = await readFile(installation.targetPath);
    try {
      validateTransformableTarget(source);
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

function assertExactMetadataBytes(bytes, expectedBytes, target, paths, invalidMessage) {
  try {
    if (!bytes.equals(expectedBytes)) throw new Error(invalidMessage);
    const metadata = JSON.parse(decodeUtf8(bytes, 'Codex provenance metadata'));
    assertMetadata(metadata, target, paths);
  } catch {
    throw new Error(invalidMessage);
  }
}

async function verifyMetadataFile(filePath, expectedBytes, target, paths, invalidMessage) {
  const bytes = await readFile(filePath).catch(() => undefined);
  if (bytes === undefined) throw new Error(invalidMessage);
  assertExactMetadataBytes(bytes, expectedBytes, target, paths, invalidMessage);
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
  await Promise.all([
    assertNotSymbolicLink(target.targetPath, 'target'),
    assertNotSymbolicLink(paths.backupPath, 'backup'),
    assertNotSymbolicLink(paths.metadataPath, 'metadata'),
  ]);
  const [backupExists, metadataExists] = await Promise.all([
    fileExists(paths.backupPath),
    fileExists(paths.metadataPath),
  ]);
  const targetBytes = await readFile(target.targetPath);

  if (backupExists && !metadataExists) {
    throw new Error('Codex provenance installation contains inconsistent patch artifacts');
  }

  if (!backupExists && !metadataExists) {
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
  if (!backupExists) {
    if (sha256(targetBytes) !== metadata.originalSha256) {
      throw new Error('Codex provenance installation contains inconsistent patch artifacts');
    }
    const expectedPatchedBytes = expectedPatchFromBackup(targetBytes, metadata);
    return {
      state: 'restored-pending-cleanup',
      target,
      paths,
      targetBytes,
      backupBytes: targetBytes,
      metadata,
      patchedBytes: expectedPatchedBytes,
    };
  }
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

async function durableSyncDirectory(directoryPath) {
  const handle = await open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function fileOperationsFor(options) {
  return {
    rename: options?.__testFileOperations?.rename ?? rename,
    rm: options?.__testFileOperations?.rm ?? rm,
    syncDirectory: options?.__testFileOperations?.syncDirectory ?? durableSyncDirectory,
    writeFile: options?.__testFileOperations?.writeFile ?? durableWriteFile,
  };
}

async function syncParentDirectory(filePath, operations) {
  await operations.syncDirectory(path.dirname(filePath));
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

async function removeDurably(filePath, operations, options) {
  let removalError;
  try {
    await operations.rm(filePath, options);
  } catch (error) {
    removalError = error;
  }
  if (await fileExists(filePath)) {
    throw removalError ?? new Error(`Could not remove ${filePath}`);
  }
  await syncParentDirectory(filePath, operations);
}

async function removeNewBackup(paths, operations) {
  try {
    await removeDurably(paths.backupPath, operations, { force: true });
    return undefined;
  } catch (error) {
    return {
      backupExists: await fileExists(paths.backupPath),
      message: errorMessage(error),
    };
  }
}

function matchesExactBytes(bytes, expectedBytes, expectedSha256) {
  return bytes !== undefined
    && bytes.equals(expectedBytes)
    && sha256(bytes) === expectedSha256;
}

async function atomicReplace(
  filePath,
  bytes,
  mode,
  operations,
  temporaryPaths,
  expectedCurrentBytes,
  expectedCurrentSha256,
  changedMessage,
) {
  const tempPath = temporaryPath(filePath);
  temporaryPaths.push(tempPath);
  await operations.writeFile(tempPath, bytes, { flag: 'wx', mode });
  if (expectedCurrentBytes !== undefined) {
    await assertNotSymbolicLink(filePath, 'target');
    const currentBytes = await readFile(filePath).catch(() => undefined);
    if (!matchesExactBytes(currentBytes, expectedCurrentBytes, expectedCurrentSha256)) {
      throw new Error(changedMessage);
    }
  }
  await operations.rename(tempPath, filePath);
  await syncParentDirectory(filePath, operations);
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
    try {
      await syncParentDirectory(analysis.paths.metadataPath, operations);
    } catch (error) {
      throw new Error(
        `Codex provenance patch is observably patched but directory durability is not confirmed; `
        + `re-run apply: ${errorMessage(error)}`,
      );
    }
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
  let metadataRenameAttempted = false;

  try {
    await operations.writeFile(analysis.paths.backupPath, analysis.targetBytes, {
      flag: 'wx',
      mode: targetMode,
    });
    backupCreated = true;
    if (!Buffer.from(await readFile(analysis.paths.backupPath)).equals(analysis.targetBytes)) {
      throw new Error('Codex provenance backup verification failed');
    }
    await syncParentDirectory(analysis.paths.backupPath, operations);

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
    await verifyMetadataFile(
      metadataTempPath,
      metadataBytes,
      analysis.target,
      analysis.paths,
      'Codex provenance metadata temporary file is invalid',
    );

    const currentImmediatelyBeforeInstall = await readFile(analysis.target.targetPath)
      .catch(() => undefined);
    if (!matchesExactBytes(
      currentImmediatelyBeforeInstall,
      analysis.targetBytes,
      originalSha256,
    )) {
      throw new Error('Codex provenance target changed during installation');
    }
    await assertNotSymbolicLink(analysis.target.targetPath, 'target');
    await operations.rename(targetTempPath, analysis.target.targetPath);
    await syncParentDirectory(analysis.target.targetPath, operations);
    if (!Buffer.from(await readFile(analysis.target.targetPath)).equals(analysis.patchedBytes)) {
      throw new Error('Codex provenance target verification failed after installation');
    }

    metadataRenameAttempted = true;
    await operations.rename(metadataTempPath, analysis.paths.metadataPath);
    await verifyMetadataFile(
      analysis.paths.metadataPath,
      metadataBytes,
      analysis.target,
      analysis.paths,
      'Codex provenance final metadata is invalid',
    );
    await syncParentDirectory(analysis.paths.metadataPath, operations);
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
      && matchesExactBytes(targetOnDisk, analysis.patchedBytes, patchedSha256)
    ) {
      try {
        await syncParentDirectory(analysis.paths.metadataPath, operations);
        await cleanupTemporaryPaths(temporaryPaths, operations);
        return resultFor('patched', analysis.target, analysis.paths);
      } catch (syncError) {
        throw new Error(
          `Codex provenance patch is observably patched but directory durability is not confirmed; `
          + `re-run apply: ${errorMessage(syncError)}`,
        );
      }
    }

    let metadataCleanupFailure;
    if (metadataRenameAttempted && metadataOnDisk !== undefined) {
      try {
        await removeDurably(analysis.paths.metadataPath, operations);
      } catch (cleanupError) {
        metadataCleanupFailure = errorMessage(cleanupError);
      }
    }

    let rollbackFailure;
    const currentTarget = await readFile(analysis.target.targetPath).catch(() => undefined);
    if (matchesExactBytes(currentTarget, analysis.patchedBytes, patchedSha256)) {
      try {
        await atomicReplace(
          analysis.target.targetPath,
          analysis.targetBytes,
          targetMode,
          operations,
          temporaryPaths,
          analysis.patchedBytes,
          patchedSha256,
          'Codex provenance target changed before install rollback',
        );
      } catch (rollbackError) {
        rollbackFailure = errorMessage(rollbackError);
      }
    } else if (!matchesExactBytes(currentTarget, analysis.targetBytes, originalSha256)) {
      rollbackFailure = 'target changed to an unknown state; rollback refused';
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

    if (metadataCleanupFailure !== undefined) {
      const cleanupState = await inspectRestoredCleanupState({
        ...analysis,
        backupBytes: analysis.targetBytes,
        metadata,
      });
      if (cleanupState === 'backup-only') {
        throw new Error(
          `Could not install Codex provenance patch: ${errorMessage(error)}; target restored and `
          + `metadata is absent, but backup retained at ${analysis.paths.backupPath}; `
          + `manual cleanup required: ${metadataCleanupFailure}`,
        );
      }
      if (cleanupState === 'clean') {
        throw new Error(
          `Could not install Codex provenance patch: ${errorMessage(error)}; target remains original `
          + `and recovery artifacts are absent, but directory durability is not confirmed; `
          + `re-run apply: ${metadataCleanupFailure}`,
        );
      }
      if (cleanupState === 'complete-artifacts' || cleanupState === 'metadata-only') {
        throw new Error(
          `Could not install Codex provenance patch: ${errorMessage(error)}; target restored with `
          + `verified recovery metadata; re-run restore: ${metadataCleanupFailure}`,
        );
      }
      throw new Error(
        `Could not install Codex provenance patch: ${errorMessage(error)}; target restored; `
        + `cleanup entered non-retryable ${cleanupState} state; manual cleanup required: `
        + metadataCleanupFailure,
      );
    }

    const backupCleanupFailure = backupCreated
      ? await removeNewBackup(analysis.paths, operations)
      : undefined;
    if (backupCleanupFailure !== undefined) {
      if (!backupCleanupFailure.backupExists) {
        throw new Error(
          `Could not install Codex provenance patch: ${errorMessage(error)}; target remains original `
          + `and backup is absent, but directory durability is not confirmed; re-run apply: `
          + backupCleanupFailure.message,
        );
      }
      throw new Error(
        `Could not install Codex provenance patch: ${errorMessage(error)}; target restored; `
        + `backup retained at ${analysis.paths.backupPath}: ${backupCleanupFailure.message}`,
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

async function inspectRestoredCleanupState(analysis) {
  const targetBytes = await readFile(analysis.target.targetPath).catch(() => undefined);
  if (!matchesExactBytes(
    targetBytes,
    analysis.backupBytes,
    analysis.metadata.originalSha256,
  )) {
    return 'target-changed';
  }
  const backupBytes = await readFile(analysis.paths.backupPath).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (
    backupBytes !== undefined
    && !matchesExactBytes(backupBytes, analysis.backupBytes, analysis.metadata.originalSha256)
  ) {
    return 'backup-changed';
  }
  const metadataExists = await fileExists(analysis.paths.metadataPath);
  if (metadataExists) {
    try {
      const currentMetadata = await readMetadata(analysis.target, analysis.paths);
      if (METADATA_KEYS.some((key) => currentMetadata[key] !== analysis.metadata[key])) {
        return 'metadata-changed';
      }
    } catch {
      return 'metadata-changed';
    }
  }
  if (backupBytes !== undefined && metadataExists) return 'complete-artifacts';
  if (backupBytes === undefined && metadataExists) return 'metadata-only';
  if (backupBytes === undefined && !metadataExists) return 'clean';
  return 'backup-only';
}

async function cleanupFailure(analysis, label, error) {
  const state = await inspectRestoredCleanupState(analysis);
  if (state === 'complete-artifacts') {
    return new Error(
      `Codex provenance target restored; recovery artifacts remain; re-run restore: `
      + `${label} cleanup failure: ${errorMessage(error)}`,
    );
  }
  if (state === 'metadata-only') {
    return new Error(
      `Codex provenance target restored; backup removed and metadata remains; re-run restore: `
      + `${label} cleanup failure: ${errorMessage(error)}`,
    );
  }
  if (state === 'clean') {
    return new Error(
      `Codex provenance target restored; cleanup observably complete but directory durability is `
      + `not confirmed; re-run restore: ${label} cleanup failure: ${errorMessage(error)}`,
    );
  }
  return new Error(
    `Codex provenance restore cleanup entered non-retryable ${state} state; manual cleanup required: `
    + `${label} cleanup failure: ${errorMessage(error)}`,
  );
}

async function cleanupRestoredArtifacts(analysis, operations) {
  if (await fileExists(analysis.paths.backupPath)) {
    try {
      await removeDurably(analysis.paths.backupPath, operations);
    } catch (error) {
      throw await cleanupFailure(analysis, 'backup', error);
    }
  }
  try {
    await removeDurably(analysis.paths.metadataPath, operations);
  } catch (error) {
    throw await cleanupFailure(analysis, 'metadata', error);
  }
}

export async function restoreCodexProvenancePatch(options = {}) {
  const operations = fileOperationsFor(options);
  const analysis = await analyze(options);
  if (analysis.state === 'clean') {
    try {
      await syncParentDirectory(analysis.target.targetPath, operations);
    } catch (error) {
      throw new Error(
        `Codex provenance target is observably restored but directory durability is not confirmed; `
        + `re-run restore: ${errorMessage(error)}`,
      );
    }
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
        analysis.patchedBytes,
        analysis.metadata.patchedSha256,
        'Codex provenance target changed during restore',
      );
    } catch (error) {
      const currentTarget = await readFile(analysis.target.targetPath).catch(() => undefined);
      const tempCleanupFailures = await cleanupTemporaryPaths(temporaryPaths, operations);
      if (!matchesExactBytes(
        currentTarget,
        analysis.backupBytes,
        analysis.metadata.originalSha256,
      )) {
        if (!matchesExactBytes(
          currentTarget,
          analysis.patchedBytes,
          analysis.metadata.patchedSha256,
        )) {
          throw new Error(
            `Codex provenance target changed during restore; recovery artifacts retained at `
            + `${analysis.paths.backupPath} and ${analysis.paths.metadataPath}: ${errorMessage(error)}`
            + (tempCleanupFailures.length === 0
              ? ''
              : `; temporary cleanup failures: ${tempCleanupFailures.join('; ')}`),
          );
        }
        throw new Error(
          `Could not restore Codex provenance patch: ${errorMessage(error)}`
          + (tempCleanupFailures.length === 0
            ? ''
            : `; temporary cleanup failures: ${tempCleanupFailures.join('; ')}`),
        );
      }
      try {
        await syncParentDirectory(analysis.target.targetPath, operations);
      } catch (syncError) {
        throw new Error(
          `Codex provenance target restored observably but directory durability is not confirmed; `
          + `re-run restore with recovery artifacts retained: ${errorMessage(syncError)}`,
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
  } else {
    try {
      await syncParentDirectory(analysis.target.targetPath, operations);
    } catch (error) {
      throw new Error(
        `Codex provenance target restored observably but directory durability is not confirmed; `
        + `re-run restore with recovery artifacts retained: ${errorMessage(error)}`,
      );
    }
  }

  await cleanupRestoredArtifacts(analysis, operations);
  return resultFor(wasPatched ? 'restored' : 'already-restored', analysis.target, analysis.paths);
}
