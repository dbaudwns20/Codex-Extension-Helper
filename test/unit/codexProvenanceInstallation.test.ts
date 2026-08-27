import {
  lstat as fsLstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename as fsRename,
  rm as fsRm,
  symlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const VSCODE_IMPORT = 'var ht=U(require("vscode"));';
const ACTIVATION_HEADER = 'async function twt(t){let{subscriptions:e}=t;e.push(K()),K().info("Activating Codex extension");';
const VSCODE_USAGE = 'ht.commands.executeCommand("setContext",Vxe,!mP(ht.version)),ht.commands.executeCommand("setContext",QSt,i);';
const NOTIFICATION_ANCHOR = 'e.push(p.registerInternalNotificationHandler(xe=>{xe.method==="turn/completed"&&_.invalidateGitReadCachesForTurn(p.takeCompletedTurnCwds(xe.params),A.id)}));';
const METADATA_KEYS = [
  'backupPath',
  'extensionVersion',
  'metadataSchemaVersion',
  'originalSha256',
  'patchVersion',
  'patchedSha256',
  'targetPath',
].sort();
const temporaryDirectories: string[] = [];

type FileOperations = {
  lstat?: (filePath: string) => ReturnType<typeof fsLstat>;
  rename?: (sourcePath: string, targetPath: string) => Promise<void>;
  rm?: (filePath: string, options?: { force?: boolean }) => Promise<void>;
  syncDirectory?: (directoryPath: string) => Promise<void>;
  writeFile?: (filePath: string, data: string | Uint8Array, options: object) => Promise<void>;
};

type InstallationOptions = {
  extensionDir?: string;
  roots?: string[];
  __testFileOperations?: FileOperations;
};

type LifecycleResult = {
  backupPath: string;
  extensionDir: string;
  extensionVersion: string;
  metadataPath: string;
  status: string;
  targetPath: string;
};

async function installationModule() {
  // @ts-expect-error Script modules are intentionally JavaScript-only.
  return import('../../scripts/lib/codex-provenance-installation.mjs') as Promise<{
    applyCodexProvenancePatch(options?: InstallationOptions): Promise<LifecycleResult>;
    inspectCodexProvenancePatch(options?: InstallationOptions): Promise<LifecycleResult>;
    restoreCodexProvenancePatch(options?: InstallationOptions): Promise<LifecycleResult>;
  }>;
}

function minifiedHostFixture(label = '한글-🙂') {
  return [
    `/* ${label} */`,
    'var Kz=U(require("vscode"));var Lh=U(require("vscode"));',
    VSCODE_IMPORT,
    'const K=()=>({info:()=>{}}),Vxe="host.version",QSt="host.lsp",mP=()=>!1;',
    'function qL(s){return s.registerInternalNotificationHandler(G=>{G.method==="item/completed"&&void 0})}',
    ACTIVATION_HEADER,
    'let i=!1,p=t.appServerClient,_={invalidateGitReadCachesForTurn:()=>{}},A={id:"host"};',
    VSCODE_USAGE,
    NOTIFICATION_ANCHOR,
    '}globalThis.__activateCodexHostFixture=twt;',
    '\n//# sourceMappingURL=extension.js.map\n',
  ].join('');
}

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-provenance-installation-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeInstallation(
  root: string,
  version: string,
  source = minifiedHostFixture(version),
) {
  const extensionDir = path.join(root, `openai.chatgpt-${version}-darwin-arm64`);
  await mkdir(path.join(extensionDir, 'out'), { recursive: true });
  await fsWriteFile(path.join(extensionDir, 'package.json'), JSON.stringify({
    name: 'chatgpt',
    version,
  }));
  await fsWriteFile(path.join(extensionDir, 'out/extension.js'), Buffer.from(source, 'utf8'));
  return extensionDir;
}

async function readOptional(filePath: string) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function tempArtifacts(extensionDir: string) {
  return (await readdir(path.join(extensionDir, 'out'))).filter((entry) => entry.includes('.tmp-'));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fsRm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('Codex provenance installation discovery and inspection', () => {
  it('selects the newest compatible installation and targets only out/extension.js', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const oldest = await makeInstallation(root, '26.820.60940');
    const newestCompatible = await makeInstallation(root, '26.826.11250');
    const newestUnsupported = await makeInstallation(root, '26.900.1', 'unsupported host source');

    const result = await applyCodexProvenancePatch({ roots: [root] });

    expect(result.extensionDir).toBe(newestCompatible);
    expect(result.extensionVersion).toBe('26.826.11250');
    expect(result.targetPath).toBe(path.join(newestCompatible, 'out/extension.js'));
    expect(await readFile(path.join(oldest, 'out/extension.js'), 'utf8')).not.toContain(
      'codex-extension-helper:provenance:start',
    );
    expect(await readFile(path.join(newestUnsupported, 'out/extension.js'), 'utf8')).toBe(
      'unsupported host source',
    );
  });

  it('honors an explicit extension directory even when a newer installation exists', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const selected = await makeInstallation(root, '26.820.60940');
    const newer = await makeInstallation(root, '26.826.11250');

    const result = await applyCodexProvenancePatch({ extensionDir: selected });

    expect(result.extensionDir).toBe(selected);
    expect(await readFile(result.targetPath, 'utf8')).toContain(
      'codex-extension-helper:provenance:start:v1',
    );
    expect(await readFile(path.join(newer, 'out/extension.js'), 'utf8')).not.toContain(
      'codex-extension-helper:provenance:start',
    );
  });

  it('fails closed on newer managed artifacts instead of mutating an older compatible install', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const older = await makeInstallation(root, '26.820.60940');
    const newer = await makeInstallation(root, '26.826.11250');
    const managed = await applyCodexProvenancePatch({ extensionDir: newer });
    await fsWriteFile(managed.targetPath, 'tampered newer host');
    const olderBefore = await readFile(path.join(older, 'out/extension.js'));

    await expect(applyCodexProvenancePatch({ roots: [root] })).rejects.toThrow(
      'Current Codex provenance target hash does not match patch metadata',
    );
    expect(await readFile(path.join(older, 'out/extension.js'))).toEqual(olderBefore);
  });

  it('propagates a newer target read failure instead of patching an older installation', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const older = await makeInstallation(root, '26.820.60940');
    const newer = await makeInstallation(root, '26.826.11250');
    const newerTarget = path.join(newer, 'out/extension.js');
    await fsRm(newerTarget);
    await mkdir(newerTarget);
    const olderTarget = path.join(older, 'out/extension.js');
    const olderBefore = await readFile(olderTarget);

    await expect(applyCodexProvenancePatch({ roots: [root] })).rejects.toMatchObject({
      code: 'EISDIR',
    });
    expect(await readFile(olderTarget)).toEqual(olderBefore);
  });

  it('reports clean and fully verified patched states without changing bytes', async () => {
    const {
      applyCodexProvenancePatch,
      inspectCodexProvenancePatch,
    } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');

    await expect(inspectCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'not-patched',
      extensionVersion: '26.826.11250',
    });
    const first = await applyCodexProvenancePatch({ extensionDir });
    const beforeInspect = await Promise.all([
      readFile(first.targetPath),
      readFile(first.backupPath),
      readFile(first.metadataPath),
    ]);

    await expect(inspectCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'patched',
      targetPath: first.targetPath,
    });
    expect(await Promise.all([
      readFile(first.targetPath),
      readFile(first.backupPath),
      readFile(first.metadataPath),
    ])).toEqual(beforeInspect);
  });
});

describe('Codex provenance installation apply lifecycle', () => {
  it('installs from exact UTF-8 bytes with an immutable adjacent backup and exact metadata schema', async () => {
    const { applyCodexProvenancePatch, restoreCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const original = Buffer.from(minifiedHostFixture('원본-🙂'), 'utf8');
    const extensionDir = await makeInstallation(root, '26.826.11250', original.toString('utf8'));
    const webviewPath = path.join(extensionDir, 'webview/assets/app-initial-current.js');
    const dropMetadataPath = `${webviewPath}.codex-explorer-drop-chips.json`;
    const dropBackupPath = `${webviewPath}.codex-explorer-drop-chips.original`;
    await mkdir(path.dirname(webviewPath), { recursive: true });
    await fsWriteFile(webviewPath, 'drop bundle sentinel');
    await fsWriteFile(dropMetadataPath, '{"drop":true}\n');
    await fsWriteFile(dropBackupPath, 'drop backup sentinel');

    const result = await applyCodexProvenancePatch({ extensionDir });
    const metadata = JSON.parse(await readFile(result.metadataPath, 'utf8'));

    expect(result.status).toBe('patched');
    expect(result.backupPath).toBe(
      `${result.targetPath}.codex-extension-helper-provenance.original`,
    );
    expect(result.metadataPath).toBe(
      `${result.targetPath}.codex-extension-helper-provenance.json`,
    );
    expect(await readFile(result.backupPath)).toEqual(original);
    expect(await readFile(result.targetPath, 'utf8')).toContain(
      '/* codex-extension-helper:provenance:start:v1 */',
    );
    expect(Object.keys(metadata).sort()).toEqual(METADATA_KEYS);
    expect(metadata).toMatchObject({
      metadataSchemaVersion: 1,
      patchVersion: 1,
      extensionVersion: '26.826.11250',
      targetPath: result.targetPath,
      backupPath: result.backupPath,
    });
    expect(path.isAbsolute(metadata.targetPath)).toBe(true);
    expect(path.isAbsolute(metadata.backupPath)).toBe(true);
    expect(metadata.originalSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.patchedSha256).toMatch(/^[a-f0-9]{64}$/u);

    await expect(restoreCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'restored',
    });
    expect(await readFile(result.targetPath)).toEqual(original);
    expect(await readFile(webviewPath, 'utf8')).toBe('drop bundle sentinel');
    expect(await readFile(dropMetadataPath, 'utf8')).toBe('{"drop":true}\n');
    expect(await readFile(dropBackupPath, 'utf8')).toBe('drop backup sentinel');
  });

  it('is idempotent only when target, backup, metadata, and source transform agree', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const first = await applyCodexProvenancePatch({ extensionDir });
    const installedBytes = await Promise.all([
      readFile(first.targetPath),
      readFile(first.backupPath),
      readFile(first.metadataPath),
    ]);

    const second = await applyCodexProvenancePatch({ extensionDir });

    expect(second.status).toBe('already-patched');
    expect(await Promise.all([
      readFile(first.targetPath),
      readFile(first.backupPath),
      readFile(first.metadataPath),
    ])).toEqual(installedBytes);
  });

  it.each([
    ['extra field', (metadata: Record<string, unknown>) => { metadata.extra = true; }],
    ['missing field', (metadata: Record<string, unknown>) => { delete metadata.originalSha256; }],
    ['schema version', (metadata: Record<string, unknown>) => { metadata.metadataSchemaVersion = 2; }],
    ['patch version', (metadata: Record<string, unknown>) => { metadata.patchVersion = 2; }],
    ['extension version', (metadata: Record<string, unknown>) => { metadata.extensionVersion = '0.0.0'; }],
    ['target path', (metadata: Record<string, unknown>) => { metadata.targetPath = '/tmp/wrong-target'; }],
    ['backup path', (metadata: Record<string, unknown>) => { metadata.backupPath = '/tmp/wrong-backup'; }],
    ['hash shape', (metadata: Record<string, unknown>) => { metadata.patchedSha256 = 'not-a-hash'; }],
  ])('rejects metadata with a mismatched %s without overwriting it', async (_name, mutate) => {
    const { applyCodexProvenancePatch, inspectCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const result = await applyCodexProvenancePatch({ extensionDir });
    const metadata = JSON.parse(await readFile(result.metadataPath, 'utf8')) as Record<string, unknown>;
    mutate(metadata);
    const malformed = `${JSON.stringify(metadata, null, 2)}\n`;
    await fsWriteFile(result.metadataPath, malformed);
    const targetBefore = await readFile(result.targetPath);

    await expect(inspectCodexProvenancePatch({ extensionDir })).rejects.toThrow(
      'Codex provenance patch metadata is invalid',
    );
    await expect(applyCodexProvenancePatch({ extensionDir })).rejects.toThrow(
      'Codex provenance patch metadata is invalid',
    );
    expect(await readFile(result.targetPath)).toEqual(targetBefore);
    expect(await readFile(result.metadataPath, 'utf8')).toBe(malformed);
  });

  it('rejects malformed JSON metadata without changing the installed target', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const result = await applyCodexProvenancePatch({ extensionDir });
    await fsWriteFile(result.metadataPath, '{broken-json\n');
    const targetBefore = await readFile(result.targetPath);

    await expect(applyCodexProvenancePatch({ extensionDir })).rejects.toThrow(
      'Codex provenance patch metadata is invalid',
    );
    expect(await readFile(result.targetPath)).toEqual(targetBefore);
  });

  it.each([
    ['missing backup', async (result: LifecycleResult) => fsRm(result.backupPath)],
    ['missing metadata', async (result: LifecycleResult) => fsRm(result.metadataPath)],
    ['tampered target', async (result: LifecycleResult) => fsWriteFile(result.targetPath, 'unknown target bytes')],
    ['tampered backup', async (result: LifecycleResult) => fsWriteFile(result.backupPath, 'unknown backup bytes')],
  ])('fails closed on a %s state without overwriting current bytes', async (_name, mutate) => {
    const { applyCodexProvenancePatch, inspectCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const result = await applyCodexProvenancePatch({ extensionDir });
    await mutate(result);
    const targetBefore = await readOptional(result.targetPath);
    const backupBefore = await readOptional(result.backupPath);
    const metadataBefore = await readOptional(result.metadataPath);

    await expect(inspectCodexProvenancePatch({ extensionDir })).rejects.toThrow();
    await expect(applyCodexProvenancePatch({ extensionDir })).rejects.toThrow();
    expect(await readOptional(result.targetPath)).toEqual(targetBefore);
    expect(await readOptional(result.backupPath)).toEqual(backupBefore);
    expect(await readOptional(result.metadataPath)).toEqual(metadataBefore);
  });

  it('rejects an unmanaged provenance marker and an orphan backup', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchCodexHostSource } = await import('../../scripts/lib/codex-provenance-source.mjs');
    const root = await makeTemporaryDirectory();
    const markedDir = await makeInstallation(root, '26.826.11250');
    const markedTarget = path.join(markedDir, 'out/extension.js');
    await fsWriteFile(markedTarget, patchCodexHostSource(await readFile(markedTarget, 'utf8')).source);
    const orphanDir = await makeInstallation(root, '26.826.11251');
    const orphanTarget = path.join(orphanDir, 'out/extension.js');
    const orphanBackup = `${orphanTarget}.codex-extension-helper-provenance.original`;
    await fsWriteFile(orphanBackup, await readFile(orphanTarget), { flag: 'wx' });

    await expect(applyCodexProvenancePatch({ extensionDir: markedDir })).rejects.toThrow(
      /inconsistent.*artifacts/u,
    );
    await expect(applyCodexProvenancePatch({ extensionDir: orphanDir })).rejects.toThrow(
      /inconsistent.*artifacts/u,
    );
  });

  it('validates an unsupported source before creating any recovery artifacts', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250', 'unsupported host source');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const original = await readFile(targetPath);

    await expect(applyCodexProvenancePatch({ extensionDir })).rejects.toThrow(
      /Codex provenance.*anchor/u,
    );
    expect(await readFile(targetPath)).toEqual(original);
    expect(await tempArtifacts(extensionDir)).toEqual([]);
    await expect(readFile(`${targetPath}.codex-extension-helper-provenance.original`))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${targetPath}.codex-extension-helper-provenance.json`))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a final-leaf target symlink without replacing it or its destination', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const realTargetPath = path.join(extensionDir, 'out/real-extension.js');
    const original = await readFile(targetPath);
    await fsRename(targetPath, realTargetPath);
    await symlink(realTargetPath, targetPath);

    await expect(applyCodexProvenancePatch({ extensionDir })).rejects.toThrow(
      /target.*symbolic link/iu,
    );

    expect(await readFile(realTargetPath)).toEqual(original);
    expect(await readFile(targetPath)).toEqual(original);
    expect(await readOptional(`${targetPath}.codex-extension-helper-provenance.original`))
      .toBeUndefined();
    expect(await readOptional(`${targetPath}.codex-extension-helper-provenance.json`))
      .toBeUndefined();
  });

  it('preserves a backup that wins an exclusive-creation race', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const backupPath = `${targetPath}.codex-extension-helper-provenance.original`;
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;
    const original = await readFile(targetPath);
    const racedBackup = Buffer.from('backup created by another process');

    await expect(applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        writeFile: async (filePath, data, options) => {
          if (filePath === backupPath) await fsWriteFile(filePath, racedBackup, { flag: 'wx' });
          await fsWriteFile(filePath, data, options);
        },
      },
    })).rejects.toThrow(/EEXIST|exist/iu);

    expect(await readFile(targetPath)).toEqual(original);
    expect(await readFile(backupPath)).toEqual(racedBackup);
    expect(await readOptional(metadataPath)).toBeUndefined();
  });

  it('preserves a concurrent backup created before a non-EEXIST write failure', async () => {
    const { applyCodexProvenancePatch, inspectCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const backupPath = `${targetPath}.codex-extension-helper-provenance.original`;
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;
    const original = await readFile(targetPath);
    const concurrentBackup = Buffer.from('backup created by a concurrent transaction');

    await expect(applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        writeFile: async (filePath) => {
          if (filePath === backupPath) {
            await fsWriteFile(filePath, concurrentBackup, { flag: 'wx' });
            throw Object.assign(new Error('backup write failed before transaction effect'), {
              code: 'EIO',
            });
          }
          throw new Error(`unexpected write to ${filePath}`);
        },
      },
    })).rejects.toThrow(/backup.*ownership.*unconfirmed.*preserved.*manual cleanup/iu);

    expect(await readFile(targetPath)).toEqual(original);
    expect(await readFile(backupPath)).toEqual(concurrentBackup);
    expect(await readOptional(metadataPath)).toBeUndefined();
    expect(await tempArtifacts(extensionDir)).toEqual([]);
    await expect(inspectCodexProvenancePatch({ extensionDir })).rejects.toThrow(
      /inconsistent.*artifacts/u,
    );
  });

  it('preserves an exact backup when its exclusive write reports an after-effect failure', async () => {
    const { applyCodexProvenancePatch, inspectCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const backupPath = `${targetPath}.codex-extension-helper-provenance.original`;
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;
    const original = await readFile(targetPath);

    await expect(applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        writeFile: async (filePath, data, options) => {
          await fsWriteFile(filePath, data, options);
          if (filePath === backupPath) {
            throw Object.assign(new Error('backup write reported after-effect failure'), {
              code: 'EIO',
            });
          }
        },
      },
    })).rejects.toThrow(/backup.*ownership.*unconfirmed.*preserved.*manual cleanup/iu);

    expect(await readFile(targetPath)).toEqual(original);
    expect(await readFile(backupPath)).toEqual(original);
    expect(await readOptional(metadataPath)).toBeUndefined();
    expect(await tempArtifacts(extensionDir)).toEqual([]);
    await expect(inspectCodexProvenancePatch({ extensionDir })).rejects.toThrow(
      /inconsistent.*artifacts/u,
    );
  });

  it('verifies newly created backup bytes before replacing the target', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const backupPath = `${targetPath}.codex-extension-helper-provenance.original`;
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;
    const original = await readFile(targetPath);

    await expect(applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        writeFile: async (filePath, data, options) => {
          await fsWriteFile(
            filePath,
            filePath === backupPath ? Buffer.from('corrupted recovery bytes') : data,
            options,
          );
        },
      },
    })).rejects.toThrow('Codex provenance backup verification failed');

    expect(await readFile(targetPath)).toEqual(original);
    expect(await readOptional(backupPath)).toBeUndefined();
    expect(await readOptional(metadataPath)).toBeUndefined();
    expect(await tempArtifacts(extensionDir)).toEqual([]);
  });

  it.each([
    ['resolves', false],
    ['throws after creation', true],
  ])('rejects a truncated metadata temporary write that %s', async (_name, throwAfterWrite) => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const backupPath = `${targetPath}.codex-extension-helper-provenance.original`;
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;
    const original = await readFile(targetPath);

    await expect(applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        writeFile: async (filePath, data, options) => {
          if (filePath.startsWith(`${metadataPath}.tmp-`)) {
            await fsWriteFile(filePath, '{"truncated":', options);
            if (throwAfterWrite) throw new Error('metadata temp write reported failure');
            return;
          }
          await fsWriteFile(filePath, data, options);
        },
      },
    })).rejects.toThrow(/metadata temporary file is invalid|metadata temp write reported failure/iu);

    expect(await readFile(targetPath)).toEqual(original);
    expect(await readOptional(backupPath)).toBeUndefined();
    expect(await readOptional(metadataPath)).toBeUndefined();
    expect(await tempArtifacts(extensionDir)).toEqual([]);
  });

  it('preserves unknown final metadata written by another transaction before rename failure', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const backupPath = `${targetPath}.codex-extension-helper-provenance.original`;
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;
    const original = await readFile(targetPath);
    const concurrentMetadata = Buffer.from('{"owner":"other-transaction"}\n');

    await expect(applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        rename: async (sourcePath, destinationPath) => {
          if (destinationPath === metadataPath) {
            await fsWriteFile(metadataPath, concurrentMetadata, { flag: 'wx' });
            throw new Error('metadata rename failed before transaction effect');
          }
          await fsRename(sourcePath, destinationPath);
        },
      },
    })).rejects.toThrow(/unknown metadata.*preserved.*manual cleanup/iu);

    expect(await readFile(targetPath)).toEqual(original);
    expect(await readFile(backupPath)).toEqual(original);
    expect(await readFile(metadataPath)).toEqual(concurrentMetadata);
    expect(await tempArtifacts(extensionDir)).toEqual([]);
  });

  it('cleans exact metadata after its rename takes effect and reports cleanup sync failure', async () => {
    const { applyCodexProvenancePatch, inspectCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const backupPath = `${targetPath}.codex-extension-helper-provenance.original`;
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;
    const original = await readFile(targetPath);
    let metadataRenameTookEffect = false;

    await expect(applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        rename: async (sourcePath, destinationPath) => {
          await fsRename(sourcePath, destinationPath);
          if (destinationPath === metadataPath) {
            metadataRenameTookEffect = true;
            await fsWriteFile(targetPath, original);
            throw new Error('metadata rename reported after-effect failure');
          }
        },
        syncDirectory: async () => {
          if (
            metadataRenameTookEffect
            && await readOptional(metadataPath) === undefined
            && (await readFile(targetPath)).equals(original)
          ) {
            throw new Error('exact metadata removal directory sync failed');
          }
        },
      },
    })).rejects.toThrow(/metadata is absent.*backup retained.*manual cleanup/iu);

    expect(await readFile(targetPath)).toEqual(original);
    expect(await readFile(backupPath)).toEqual(original);
    expect(await readOptional(metadataPath)).toBeUndefined();
    await expect(inspectCodexProvenancePatch({ extensionDir })).rejects.toThrow(
      /inconsistent.*artifacts/u,
    );
  });

  it.each([
    ['patched temporary write', 'write-target'],
    ['metadata temporary write', 'write-metadata'],
    ['target rename', 'rename-target'],
    ['metadata rename', 'rename-metadata'],
  ])('rolls back a fresh install after %s failure and removes every temporary artifact', async (_name, failure) => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const backupPath = `${targetPath}.codex-extension-helper-provenance.original`;
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;
    const original = await readFile(targetPath);
    const operations: FileOperations = {
      writeFile: async (filePath, data, options) => {
        if (failure === 'write-target' && filePath.startsWith(`${targetPath}.tmp-`)) {
          throw new Error('injected patched temporary write failure');
        }
        if (failure === 'write-metadata' && filePath.startsWith(`${metadataPath}.tmp-`)) {
          throw new Error('injected metadata temporary write failure');
        }
        await fsWriteFile(filePath, data, options);
      },
      rename: async (sourcePath, destinationPath) => {
        if (failure === 'rename-target' && destinationPath === targetPath) {
          throw new Error('injected target rename failure');
        }
        if (failure === 'rename-metadata' && destinationPath === metadataPath) {
          throw new Error('injected metadata rename failure');
        }
        await fsRename(sourcePath, destinationPath);
      },
    };

    await expect(applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: operations,
    })).rejects.toThrow(/injected/u);

    expect(await readFile(targetPath)).toEqual(original);
    expect(await readOptional(backupPath)).toBeUndefined();
    expect(await readOptional(metadataPath)).toBeUndefined();
    expect(await tempArtifacts(extensionDir)).toEqual([]);
  });

  it('retains the immutable backup and reports a recoverable state when install rollback fails', async () => {
    const { applyCodexProvenancePatch, inspectCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const backupPath = `${targetPath}.codex-extension-helper-provenance.original`;
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;
    const original = await readFile(targetPath);
    let targetRenames = 0;

    await expect(applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        rename: async (sourcePath, destinationPath) => {
          if (destinationPath === targetPath) {
            targetRenames += 1;
            if (targetRenames === 2) throw new Error('injected rollback rename failure');
          }
          if (destinationPath === metadataPath) throw new Error('injected metadata rename failure');
          await fsRename(sourcePath, destinationPath);
        },
      },
    })).rejects.toThrow(/rollback.*failed.*backup retained/iu);

    expect(await readFile(backupPath)).toEqual(original);
    expect(await readFile(targetPath, 'utf8')).toContain(
      'codex-extension-helper:provenance:start:v1',
    );
    expect(await readOptional(metadataPath)).toBeUndefined();
    expect(await tempArtifacts(extensionDir)).toEqual([]);
    await expect(inspectCodexProvenancePatch({ extensionDir })).rejects.toThrow(
      /inconsistent.*artifacts/u,
    );
  });

  it('preserves a target changed while apply is writing temporary files', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const backupPath = `${targetPath}.codex-extension-helper-provenance.original`;
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;
    const concurrentBytes = Buffer.from('concurrent apply-window target bytes');

    await expect(applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        writeFile: async (filePath, data, options) => {
          await fsWriteFile(filePath, data, options);
          if (filePath.startsWith(`${metadataPath}.tmp-`)) {
            await fsWriteFile(targetPath, concurrentBytes);
          }
        },
      },
    })).rejects.toThrow(/target changed.*backup retained/iu);

    expect(await readFile(targetPath)).toEqual(concurrentBytes);
    expect(await readFile(backupPath)).toBeDefined();
    expect(await readOptional(metadataPath)).toBeUndefined();
    expect(await tempArtifacts(extensionDir)).toEqual([]);
  });

  it('performs the final symlink check before the exact target read boundary', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const backupPath = `${targetPath}.codex-extension-helper-provenance.original`;
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;
    const concurrentBytes = Buffer.from('concurrent former-lstat-window target bytes');

    await expect(applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        lstat: async (filePath) => {
          const fileStats = await fsLstat(filePath);
          if (filePath === targetPath) await fsWriteFile(targetPath, concurrentBytes);
          return fileStats;
        },
      },
    })).rejects.toThrow(/target changed.*backup retained/iu);

    expect(await readFile(targetPath)).toEqual(concurrentBytes);
    expect(await readFile(backupPath)).toBeDefined();
    expect(await readOptional(metadataPath)).toBeUndefined();
    expect(await tempArtifacts(extensionDir)).toEqual([]);
  });

  it('never rolls original bytes over a target changed after patched installation', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const backupPath = `${targetPath}.codex-extension-helper-provenance.original`;
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;
    const concurrentBytes = Buffer.from('concurrent rollback-window target bytes');

    await expect(applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        rename: async (sourcePath, destinationPath) => {
          if (destinationPath === metadataPath) {
            await fsWriteFile(targetPath, concurrentBytes);
            throw new Error('metadata commit blocked after target mutation');
          }
          await fsRename(sourcePath, destinationPath);
        },
      },
    })).rejects.toThrow(/target changed.*backup retained/iu);

    expect(await readFile(targetPath)).toEqual(concurrentBytes);
    expect(await readFile(backupPath)).toBeDefined();
    expect(await readOptional(metadataPath)).toBeUndefined();
    expect(await tempArtifacts(extensionDir)).toEqual([]);
  });

  it('reports an absent backup accurately when failed-apply cleanup directory sync fails', async () => {
    const { applyCodexProvenancePatch, inspectCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const backupPath = `${targetPath}.codex-extension-helper-provenance.original`;
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;
    const original = await readFile(targetPath);

    await expect(applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        rename: async (_sourcePath, destinationPath) => {
          if (destinationPath === targetPath) throw new Error('target install rename failed');
        },
        syncDirectory: async () => {
          if (
            await readOptional(backupPath) === undefined
            && await readOptional(metadataPath) === undefined
          ) {
            throw new Error('failed-apply cleanup directory sync failed');
          }
        },
      },
    })).rejects.toThrow(/target remains original.*backup is absent.*durability.*re-run apply/iu);

    expect(await readFile(targetPath)).toEqual(original);
    expect(await readOptional(backupPath)).toBeUndefined();
    expect(await readOptional(metadataPath)).toBeUndefined();
    await expect(inspectCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'not-patched',
    });
    await expect(applyCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'patched',
    });
  });
});

describe('Codex provenance restore lifecycle', () => {
  it('atomically restores exact backup bytes, removes managed artifacts, and is repeatable', async () => {
    const {
      applyCodexProvenancePatch,
      inspectCodexProvenancePatch,
      restoreCodexProvenancePatch,
    } = await installationModule();
    const root = await makeTemporaryDirectory();
    const original = Buffer.from(minifiedHostFixture('restore-정확성-🙂'), 'utf8');
    const extensionDir = await makeInstallation(root, '26.826.11250', original.toString('utf8'));
    const installed = await applyCodexProvenancePatch({ extensionDir });

    const restored = await restoreCodexProvenancePatch({ extensionDir });

    expect(restored.status).toBe('restored');
    expect(await readFile(installed.targetPath)).toEqual(original);
    expect(await readOptional(installed.backupPath)).toBeUndefined();
    expect(await readOptional(installed.metadataPath)).toBeUndefined();
    expect(await tempArtifacts(extensionDir)).toEqual([]);
    await expect(inspectCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'not-patched',
    });
    await expect(restoreCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'already-restored',
      targetPath: installed.targetPath,
    });
  });

  it.each([
    ['current target', async (result: LifecycleResult) => fsWriteFile(result.targetPath, 'changed target')],
    ['backup', async (result: LifecycleResult) => fsWriteFile(result.backupPath, 'changed backup')],
    ['metadata', async (result: LifecycleResult) => fsWriteFile(result.metadataPath, '{"stale":true}\n')],
    ['missing backup', async (result: LifecycleResult) => fsRm(result.backupPath)],
    ['missing metadata', async (result: LifecycleResult) => fsRm(result.metadataPath)],
  ])('refuses to restore a tampered or partial %s state', async (_name, mutate) => {
    const { applyCodexProvenancePatch, restoreCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const result = await applyCodexProvenancePatch({ extensionDir });
    await mutate(result);
    const targetBefore = await readOptional(result.targetPath);
    const backupBefore = await readOptional(result.backupPath);
    const metadataBefore = await readOptional(result.metadataPath);

    await expect(restoreCodexProvenancePatch({ extensionDir })).rejects.toThrow();
    expect(await readOptional(result.targetPath)).toEqual(targetBefore);
    expect(await readOptional(result.backupPath)).toEqual(backupBefore);
    expect(await readOptional(result.metadataPath)).toEqual(metadataBefore);
  });

  it('leaves the verified patched state retryable after an atomic restore rename failure', async () => {
    const { applyCodexProvenancePatch, restoreCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const result = await applyCodexProvenancePatch({ extensionDir });
    const patched = await readFile(result.targetPath);
    const backup = await readFile(result.backupPath);
    const metadata = await readFile(result.metadataPath);

    await expect(restoreCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        rename: async (_sourcePath, destinationPath) => {
          if (destinationPath === result.targetPath) throw new Error('injected restore rename failure');
        },
      },
    })).rejects.toThrow('injected restore rename failure');

    expect(await readFile(result.targetPath)).toEqual(patched);
    expect(await readFile(result.backupPath)).toEqual(backup);
    expect(await readFile(result.metadataPath)).toEqual(metadata);
    expect(await tempArtifacts(extensionDir)).toEqual([]);
    await expect(restoreCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'restored',
    });
  });

  it('preserves a target changed while restore is writing its temporary file', async () => {
    const { applyCodexProvenancePatch, restoreCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const result = await applyCodexProvenancePatch({ extensionDir });
    const concurrentBytes = Buffer.from('concurrent restore-window target bytes');

    await expect(restoreCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        writeFile: async (filePath, data, options) => {
          await fsWriteFile(filePath, data, options);
          if (filePath.startsWith(`${result.targetPath}.tmp-`)) {
            await fsWriteFile(result.targetPath, concurrentBytes);
          }
        },
      },
    })).rejects.toThrow(/target changed.*recovery artifacts retained/iu);

    expect(await readFile(result.targetPath)).toEqual(concurrentBytes);
    expect(await readFile(result.backupPath)).toBeDefined();
    expect(await readFile(result.metadataPath)).toBeDefined();
    expect(await tempArtifacts(extensionDir)).toEqual([]);
  });

  it('reports and preserves a target changed after the restore rename takes effect', async () => {
    const { applyCodexProvenancePatch, restoreCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const result = await applyCodexProvenancePatch({ extensionDir });
    const concurrentBytes = Buffer.from('concurrent post-restore target bytes');

    await expect(restoreCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        rename: async (sourcePath, destinationPath) => {
          await fsRename(sourcePath, destinationPath);
          if (destinationPath === result.targetPath) {
            await fsWriteFile(result.targetPath, concurrentBytes);
            throw new Error('restore rename reported a late failure');
          }
        },
      },
    })).rejects.toThrow(/target changed.*recovery artifacts retained/iu);

    expect(await readFile(result.targetPath)).toEqual(concurrentBytes);
    expect(await readFile(result.backupPath)).toBeDefined();
    expect(await readFile(result.metadataPath)).toBeDefined();
    expect(await tempArtifacts(extensionDir)).toEqual([]);
  });

  it('reports complete recovery artifacts after metadata cleanup fails and retries cleanup safely', async () => {
    const {
      applyCodexProvenancePatch,
      inspectCodexProvenancePatch,
      restoreCodexProvenancePatch,
    } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const result = await applyCodexProvenancePatch({ extensionDir });
    const original = await readFile(result.backupPath);

    await expect(restoreCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        rm: async (filePath, options) => {
          if (filePath === result.metadataPath) throw new Error('injected metadata cleanup failure');
          await fsRm(filePath, options);
        },
      },
    })).rejects.toThrow(/target restored.*re-run restore.*metadata cleanup failure/iu);

    expect(await readFile(result.targetPath)).toEqual(original);
    expect(await readOptional(result.backupPath)).toBeUndefined();
    expect(await readFile(result.metadataPath)).toBeDefined();
    await expect(inspectCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'restored-pending-cleanup',
    });
    await expect(restoreCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'already-restored',
    });
    expect(await readOptional(result.backupPath)).toBeUndefined();
    expect(await readOptional(result.metadataPath)).toBeUndefined();
  });

  it('retains complete recovery artifacts when backup cleanup fails and retries safely', async () => {
    const {
      applyCodexProvenancePatch,
      inspectCodexProvenancePatch,
      restoreCodexProvenancePatch,
    } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const result = await applyCodexProvenancePatch({ extensionDir });
    const original = await readFile(result.backupPath);

    await expect(restoreCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        rm: async (filePath, options) => {
          if (filePath === result.backupPath) throw new Error('injected backup cleanup failure');
          await fsRm(filePath, options);
        },
      },
    })).rejects.toThrow(/target restored.*re-run restore.*backup cleanup failure/iu);

    expect(await readFile(result.targetPath)).toEqual(original);
    expect(await readFile(result.backupPath)).toEqual(original);
    expect(await readFile(result.metadataPath)).toBeDefined();
    await expect(inspectCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'restored-pending-cleanup',
    });
    await expect(restoreCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'already-restored',
    });
  });

  it('does not recommend retry when metadata hashes change during cleanup failure', async () => {
    const { applyCodexProvenancePatch, inspectCodexProvenancePatch, restoreCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const result = await applyCodexProvenancePatch({ extensionDir });

    await expect(restoreCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        rm: async (filePath, options) => {
          if (filePath === result.metadataPath) {
            const metadata = JSON.parse(await readFile(filePath, 'utf8'));
            metadata.patchedSha256 = 'f'.repeat(64);
            await fsWriteFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`);
            throw new Error('metadata changed during cleanup');
          }
          await fsRm(filePath, options);
        },
      },
    })).rejects.toThrow(/non-retryable metadata-changed.*manual cleanup/iu);

    await expect(inspectCodexProvenancePatch({ extensionDir })).rejects.toThrow(
      'Codex provenance patch metadata is invalid',
    );
  });

  it.each([
    ['backup', (result: LifecycleResult) => result.backupPath],
    ['metadata', (result: LifecycleResult) => result.metadataPath],
  ])('accepts a %s delete that takes effect before reporting failure', async (_name, selectedPath) => {
    const { applyCodexProvenancePatch, restoreCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const result = await applyCodexProvenancePatch({ extensionDir });
    const pathToFail = selectedPath(result);

    await expect(restoreCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        rm: async (filePath, options) => {
          await fsRm(filePath, options);
          if (filePath === pathToFail) throw new Error(`${_name} delete reported after-effect failure`);
        },
      },
    })).resolves.toMatchObject({ status: 'restored' });

    expect(await readOptional(result.backupPath)).toBeUndefined();
    expect(await readOptional(result.metadataPath)).toBeUndefined();
    expect(await readFile(result.targetPath, 'utf8')).not.toContain(
      'codex-extension-helper:provenance:start',
    );
  });

  it('fsyncs each committed apply and restore directory state in durable order', async () => {
    const { applyCodexProvenancePatch, restoreCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const backupPath = `${targetPath}.codex-extension-helper-provenance.original`;
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;
    const snapshots: Array<{ backup: boolean; metadata: boolean; target: string }> = [];
    const syncDirectory = async (directoryPath: string) => {
      expect(directoryPath).toBe(path.dirname(targetPath));
      const targetSource = await readFile(targetPath, 'utf8');
      snapshots.push({
        backup: await readOptional(backupPath) !== undefined,
        metadata: await readOptional(metadataPath) !== undefined,
        target: targetSource.includes('codex-extension-helper:provenance:start')
          ? 'patched'
          : 'original',
      });
    };

    await applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: { syncDirectory },
    });
    expect(snapshots.splice(0)).toEqual([
      { backup: true, metadata: false, target: 'original' },
      { backup: true, metadata: false, target: 'patched' },
      { backup: true, metadata: true, target: 'patched' },
    ]);

    await restoreCodexProvenancePatch({
      extensionDir,
      __testFileOperations: { syncDirectory },
    });
    expect(snapshots).toEqual([
      { backup: true, metadata: true, target: 'original' },
      { backup: false, metadata: true, target: 'original' },
      { backup: false, metadata: false, target: 'original' },
    ]);
  });

  it('rolls apply back without claiming success when patched-target directory sync fails', async () => {
    const { applyCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const backupPath = `${targetPath}.codex-extension-helper-provenance.original`;
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;
    const original = await readFile(targetPath);

    await expect(applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        syncDirectory: async () => {
          const targetSource = await readFile(targetPath, 'utf8');
          if (
            targetSource.includes('codex-extension-helper:provenance:start')
            && await readOptional(metadataPath) === undefined
          ) {
            throw new Error('patched target directory sync failed');
          }
        },
      },
    })).rejects.toThrow('patched target directory sync failed');

    expect(await readFile(targetPath)).toEqual(original);
    expect(await readOptional(backupPath)).toBeUndefined();
    expect(await readOptional(metadataPath)).toBeUndefined();
  });

  it('reports an observably patched state when metadata directory sync cannot commit', async () => {
    const { applyCodexProvenancePatch, inspectCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');
    const metadataPath = `${targetPath}.codex-extension-helper-provenance.json`;

    await expect(applyCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        syncDirectory: async () => {
          if (await readOptional(metadataPath) !== undefined) {
            throw new Error('metadata directory sync failed');
          }
        },
      },
    })).rejects.toThrow(/observably patched.*durability.*re-run apply/iu);

    await expect(inspectCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'patched',
    });
    await expect(applyCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'already-patched',
    });
  });

  it('retains complete artifacts when restored-target directory sync fails', async () => {
    const { applyCodexProvenancePatch, inspectCodexProvenancePatch, restoreCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const result = await applyCodexProvenancePatch({ extensionDir });

    await expect(restoreCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        syncDirectory: async () => {
          const targetSource = await readFile(result.targetPath, 'utf8');
          if (!targetSource.includes('codex-extension-helper:provenance:start')) {
            throw new Error('restored target directory sync failed');
          }
        },
      },
    })).rejects.toThrow(/target restored.*durability.*re-run restore/iu);

    expect(await readFile(result.backupPath)).toBeDefined();
    expect(await readFile(result.metadataPath)).toBeDefined();
    await expect(inspectCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'restored-pending-cleanup',
    });
    await expect(restoreCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'already-restored',
    });
  });

  it('supports retry when backup removal is visible but its directory sync fails', async () => {
    const { applyCodexProvenancePatch, inspectCodexProvenancePatch, restoreCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const result = await applyCodexProvenancePatch({ extensionDir });

    await expect(restoreCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        syncDirectory: async () => {
          if (
            await readOptional(result.backupPath) === undefined
            && await readOptional(result.metadataPath) !== undefined
          ) {
            throw new Error('backup removal directory sync failed');
          }
        },
      },
    })).rejects.toThrow(/backup removed.*metadata remains.*re-run restore/iu);

    await expect(inspectCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'restored-pending-cleanup',
    });
    await expect(restoreCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'already-restored',
    });
  });

  it('reports both-gone cleanup after final metadata directory sync fails', async () => {
    const { applyCodexProvenancePatch, inspectCodexProvenancePatch, restoreCodexProvenancePatch } = await installationModule();
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const result = await applyCodexProvenancePatch({ extensionDir });

    await expect(restoreCodexProvenancePatch({
      extensionDir,
      __testFileOperations: {
        syncDirectory: async () => {
          if (
            await readOptional(result.backupPath) === undefined
            && await readOptional(result.metadataPath) === undefined
          ) {
            throw new Error('metadata removal directory sync failed');
          }
        },
      },
    })).rejects.toThrow(/cleanup observably complete.*re-run restore/iu);

    await expect(inspectCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'not-patched',
    });
    await expect(restoreCodexProvenancePatch({ extensionDir })).resolves.toMatchObject({
      status: 'already-restored',
    });
  });
});
