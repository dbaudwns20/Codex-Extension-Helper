import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const VSCODE_IMPORT = 'var ht=U(require("vscode"));';
const ACTIVATION_HEADER = 'async function twt(t){let{subscriptions:e}=t;e.push(K()),K().info("Activating Codex extension");';
const VSCODE_USAGE = 'ht.commands.executeCommand("setContext",Vxe,!mP(ht.version)),ht.commands.executeCommand("setContext",QSt,i);';
const NOTIFICATION_ANCHOR = 'e.push(p.registerInternalNotificationHandler(xe=>{xe.method==="turn/completed"&&_.invalidateGitReadCachesForTurn(p.takeCompletedTurnCwds(xe.params),A.id)}));';
const patchScript = path.resolve('scripts/patch-codex-provenance.mjs');
const restoreScript = path.resolve('scripts/unpatch-codex-provenance.mjs');
const temporaryDirectories: string[] = [];

function hostSource() {
  return [
    'var Kz=U(require("vscode"));var Lh=U(require("vscode"));',
    VSCODE_IMPORT,
    'const K=()=>({info:()=>{}}),Vxe="host.version",QSt="host.lsp",mP=()=>!1;',
    ACTIVATION_HEADER,
    'let i=!1,p=t.appServerClient,_={invalidateGitReadCachesForTurn:()=>{}},A={id:"host"};',
    VSCODE_USAGE,
    NOTIFICATION_ANCHOR,
    '}\n',
  ].join('');
}

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-provenance-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeInstallation(root: string, version: string, source = hostSource()) {
  const extensionDir = path.join(root, `openai.chatgpt-${version}-darwin-arm64`);
  await mkdir(path.join(extensionDir, 'out'), { recursive: true });
  await writeFile(path.join(extensionDir, 'package.json'), JSON.stringify({ name: 'chatgpt', version }));
  await writeFile(path.join(extensionDir, 'out/extension.js'), source);
  return extensionDir;
}

function run(scriptPath: string, arguments_: string[] = [], environment?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [scriptPath, ...arguments_], {
    encoding: 'utf8',
    env: environment ?? process.env,
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('Codex provenance patch CLIs', () => {
  it('reports explicit target, statuses, and reload guidance across apply and restore', async () => {
    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250');
    const targetPath = path.join(extensionDir, 'out/extension.js');

    const patched = run(patchScript, ['--extension-dir', extensionDir]);
    expect(patched.status).toBe(0);
    expect(patched.stdout).toContain('Patched Codex 26.826.11250');
    expect(patched.stdout).toContain(`Installation: ${extensionDir}`);
    expect(patched.stdout).toContain(`Target: ${targetPath}`);
    expect(patched.stdout).toContain('Status: patched');
    expect(patched.stdout).toContain('Reload VS Code');

    const alreadyPatched = run(patchScript, ['--extension-dir', extensionDir]);
    expect(alreadyPatched.status).toBe(0);
    expect(alreadyPatched.stdout).toContain('already patched');
    expect(alreadyPatched.stdout).toContain(`Target: ${targetPath}`);
    expect(alreadyPatched.stdout).toContain('Status: already-patched');
    expect(alreadyPatched.stdout).not.toContain('Reload VS Code');

    const restored = run(restoreScript, ['--extension-dir', extensionDir]);
    expect(restored.status).toBe(0);
    expect(restored.stdout).toContain('Restored Codex 26.826.11250');
    expect(restored.stdout).toContain(`Installation: ${extensionDir}`);
    expect(restored.stdout).toContain(`Target: ${targetPath}`);
    expect(restored.stdout).toContain('Status: restored');
    expect(restored.stdout).toContain('Reload VS Code');

    const alreadyRestored = run(restoreScript, ['--extension-dir', extensionDir]);
    expect(alreadyRestored.status).toBe(0);
    expect(alreadyRestored.stdout).toContain('already restored');
    expect(alreadyRestored.stdout).toContain('Status: already-restored');
    expect(alreadyRestored.stdout).not.toContain('Reload VS Code');
  });

  it('discovers the newest compatible local installation under VS Code roots', async () => {
    const home = await makeTemporaryDirectory();
    const extensionsRoot = path.join(home, '.vscode/extensions');
    await mkdir(extensionsRoot, { recursive: true });
    const selected = await makeInstallation(extensionsRoot, '26.826.11250');
    const older = await makeInstallation(extensionsRoot, '26.820.60940');
    await makeInstallation(extensionsRoot, '26.900.1', 'unsupported host source');

    const patched = run(patchScript, [], { ...process.env, HOME: home });

    expect(patched.status).toBe(0);
    expect(patched.stdout).toContain(`Installation: ${selected}`);
    expect(patched.stdout).toContain(`Target: ${path.join(selected, 'out/extension.js')}`);
    expect(patched.stdout).toContain('Status: patched');
    expect(await readFile(path.join(selected, 'out/extension.js'), 'utf8')).toContain(
      'codex-extension-helper:provenance:start:v1',
    );
    expect(await readFile(path.join(older, 'out/extension.js'), 'utf8')).not.toContain(
      'codex-extension-helper:provenance:start',
    );
  });

  it('prints concise nonzero errors for bad arguments and unsupported sources', async () => {
    const malformed = run(patchScript, ['--unexpected']);
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain('Codex provenance patch failed: Usage:');
    expect(malformed.stderr.trim().split('\n')).toHaveLength(1);

    const root = await makeTemporaryDirectory();
    const extensionDir = await makeInstallation(root, '26.826.11250', 'unsupported host source');
    const incompatible = run(restoreScript, ['--extension-dir', extensionDir]);
    expect(incompatible.status).toBe(1);
    expect(incompatible.stderr).toContain('Codex provenance restore failed:');
    expect(incompatible.stderr.trim().split('\n')).toHaveLength(1);
  });
});
