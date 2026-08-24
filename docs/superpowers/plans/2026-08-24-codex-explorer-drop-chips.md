# Codex Explorer Drop Chips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Patch the locally installed Codex VS Code webview so every file or folder dropped from Explorer becomes one native Codex file-mention chip, with repeatable patch and safe restore commands.

**Architecture:** A pure ESM module recognizes the unique minified Codex composer anchor and generates a marked capture-phase drop handler that calls Codex's existing `addFileDescriptorsAsMentions` closure. A separate installation module discovers Codex bundles and applies or restores the transformation atomically with hash-checked backup metadata; thin CLIs expose those operations through npm scripts.

**Tech Stack:** Node.js ESM, TypeScript/Vitest tests, VS Code extension package scripts, SHA-256 via `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-08-24-codex-explorer-drop-chips-design.md`

## Global Constraints

- A separate VS Code extension cannot access another extension's isolated webview through the public VS Code API; this is an explicit local patch to `openai.chatgpt-*`.
- One dropped Explorer item produces exactly one descriptor and one native mention chip; directories are never traversed.
- Only `file:` entries from `text/uri-list` are consumed; unsupported or empty drops retain existing Codex behavior.
- Unknown, missing, or duplicate composer anchors fail closed before any installation file is changed.
- Patch and restore are idempotent, hash checked, backed up, and atomic.
- Existing repository source changes outside the files named below remain untouched.

---

## File Structure

- Create `scripts/lib/codex-drop-source.mjs`: pure URI parsing, descriptor generation, anchor recognition, injection generation, patching, and unpatching.
- Create `scripts/lib/codex-drop-installation.mjs`: extension discovery, bundle selection, hashing, metadata validation, atomic patch, and safe restore.
- Create `scripts/patch-codex-drop.mjs`: patch CLI with optional `--extension-dir`.
- Create `scripts/unpatch-codex-drop.mjs`: restore CLI with optional `--extension-dir`.
- Create `test/unit/codexDropSource.test.ts`: pure source and URI behavior tests.
- Create `test/unit/codexDropInstallation.test.ts`: temporary-installation lifecycle tests.
- Create `test/unit/codexDropCli.test.ts`: command-line success and failure contract tests.
- Modify `package.json`: add `patch:codex-drop` and `unpatch:codex-drop` scripts.
- Modify `README.md`: document compatibility, commands, reload, update reapplication, and restore.

### Task 1: Pure URI and Codex Bundle Transformation

**Files:**
- Create: `scripts/lib/codex-drop-source.mjs`
- Create: `test/unit/codexDropSource.test.ts`

**Interfaces:**
- Consumes: browser-compatible `text/uri-list` strings and Codex webview bundle source.
- Produces: `parseFileUriList(text, platform) -> string[]`, `descriptorsFromUriList(text, platform) -> Array<{label,path,fsPath}>`, `patchBundleSource(source) -> {status:'patched'|'already-patched', source}`, `unpatchBundleSource(source) -> {status:'restored'|'not-patched', source}`, and exported marker/version constants.

- [ ] **Step 1: Write failing URI and descriptor tests**

Add `test/unit/codexDropSource.test.ts` with these concrete cases:

```ts
import { describe, expect, it } from 'vitest';

describe('Codex drop source transformation', () => {
  it('creates one descriptor for each file or directory URI', async () => {
    const { descriptorsFromUriList } = await import('../../scripts/lib/codex-drop-source.mjs');
    expect(descriptorsFromUriList([
      'file:///Users/me/project/src/Button.tsx',
      'file:///Users/me/project/src/components',
    ].join('\r\n'), 'posix')).toEqual([
      {
        label: 'Button.tsx',
        path: '/Users/me/project/src/Button.tsx',
        fsPath: '/Users/me/project/src/Button.tsx',
      },
      {
        label: 'components',
        path: '/Users/me/project/src/components',
        fsPath: '/Users/me/project/src/components',
      },
    ]);
  });

  it('decodes spaces and Unicode while ignoring comments and non-file URIs', async () => {
    const { parseFileUriList } = await import('../../scripts/lib/codex-drop-source.mjs');
    expect(parseFileUriList([
      '# Explorer resources',
      'file:///Users/me/My%20Project/%ED%95%9C%EA%B8%80.ts',
      '',
      'https://example.com/not-local',
    ].join('\n'), 'posix')).toEqual(['/Users/me/My Project/한글.ts']);
  });

  it('normalizes Windows drive and UNC file URIs without expanding directories', async () => {
    const { parseFileUriList } = await import('../../scripts/lib/codex-drop-source.mjs');
    expect(parseFileUriList('file:///C:/repo/src', 'win32')).toEqual(['C:\\repo\\src']);
    expect(parseFileUriList('file://server/share/repo', 'win32')).toEqual([
      '\\\\server\\share\\repo',
    ]);
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run test/unit/codexDropSource.test.ts`

Expected: FAIL because `scripts/lib/codex-drop-source.mjs` does not exist.

- [ ] **Step 3: Implement URI parsing and descriptor generation**

Create the module with browser-compatible logic that the injection generator can embed verbatim:

```js
import path from 'node:path';

export const PATCH_VERSION = 1;
export const PATCH_START_MARKER = '/* codex-explorer-drop-chips:start:v1 */';
export const PATCH_END_MARKER = '/* codex-explorer-drop-chips:end:v1 */';

export function filePathFromUri(value, platform = process.platform) {
  const uri = new URL(value);
  if (uri.protocol !== 'file:') return undefined;
  let pathname = decodeURIComponent(uri.pathname);
  if (platform === 'win32') {
    if (/^\/[A-Za-z]:\//u.test(pathname)) pathname = pathname.slice(1);
    pathname = pathname.replaceAll('/', '\\');
    return uri.hostname ? `\\\\${uri.hostname}${pathname}` : pathname;
  }
  return uri.hostname ? `//${uri.hostname}${pathname}` : pathname;
}

export function parseFileUriList(text, platform = process.platform) {
  const paths = [];
  for (const line of text.split(/\r?\n/u)) {
    const value = line.trim();
    if (value === '' || value.startsWith('#')) continue;
    try {
      const filePath = filePathFromUri(value, platform);
      if (filePath !== undefined) paths.push(filePath);
    } catch {
      // An invalid or unsupported URI is not consumed.
    }
  }
  return paths;
}

export function descriptorsFromUriList(text, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return parseFileUriList(text, platform).map((fsPath) => ({
    label: pathApi.basename(fsPath.replace(/[\\/]+$/u, '')) || fsPath,
    path: fsPath,
    fsPath,
  }));
}
```

- [ ] **Step 4: Run the focused tests and confirm URI cases pass**

Run: `npx vitest run test/unit/codexDropSource.test.ts`

Expected: 3 tests PASS.

- [ ] **Step 5: Add failing anchor, injection, idempotence, and restore tests**

Append tests using the exact currently installed anchor shape:

```ts
const anchor = 'IR(`add-context-file`,it.view.dom,e=>{Ei(),bee([e.file])});';

it('injects a marked native mention drop handler after one composer anchor', async () => {
  const { PATCH_START_MARKER, patchBundleSource } = await import(
    '../../scripts/lib/codex-drop-source.mjs'
  );
  const result = patchBundleSource(`before;${anchor}after;`);
  expect(result.status).toBe('patched');
  expect(result.source).toContain(PATCH_START_MARKER);
  expect(result.source).toContain('bee(descriptors)');
  expect(result.source).toContain('it.view.dom');
  expect(result.source).toContain('stopImmediatePropagation');
});

it('is idempotent and restores the exact original source', async () => {
  const { patchBundleSource, unpatchBundleSource } = await import(
    '../../scripts/lib/codex-drop-source.mjs'
  );
  const original = `before;${anchor}after;`;
  const patched = patchBundleSource(original);
  expect(patchBundleSource(patched.source)).toEqual({
    status: 'already-patched',
    source: patched.source,
  });
  expect(unpatchBundleSource(patched.source)).toEqual({
    status: 'restored',
    source: original,
  });
});

it.each([
  ['missing', 'no composer here'],
  ['duplicate', `${anchor}${anchor}`],
])('rejects a %s composer anchor', async (_name, source) => {
  const { patchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
  expect(() => patchBundleSource(source)).toThrow(/exactly one Codex composer anchor/u);
});
```

- [ ] **Step 6: Run the focused test to verify transformation cases fail**

Run: `npx vitest run test/unit/codexDropSource.test.ts`

Expected: FAIL because `patchBundleSource` and `unpatchBundleSource` are not exported.

- [ ] **Step 7: Implement strict anchor capture and injection generation**

Use a regex that has been verified to match the installed `26.818.61809` bundle exactly once:

```js
const COMPOSER_ANCHOR = /IR\(`add-context-file`,(?<controller>[A-Za-z_$][\w$]*)\.view\.dom,(?<event>[A-Za-z_$][\w$]*)=>\{(?<focus>[A-Za-z_$][\w$]*)\(\),(?<add>[A-Za-z_$][\w$]*)\(\[\k<event>\.file\]\)\}\);/gu;

function browserDropInjection({ controller, add }) {
  return `${PATCH_START_MARKER}(()=>{const composer=${controller}.view.dom;if(composer.dataset.codexExplorerDropChips==='1')return;composer.dataset.codexExplorerDropChips='1';const descriptorsFromDrop=(text)=>{const descriptors=[];for(const raw of text.split(/\\r?\\n/u)){const value=raw.trim();if(value===''||value.startsWith('#'))continue;try{const uri=new URL(value);if(uri.protocol!=='file:')continue;let fsPath=decodeURIComponent(uri.pathname);if(/^\\/[A-Za-z]:\\//u.test(fsPath))fsPath=fsPath.slice(1).replaceAll('/','\\\\');else if(uri.hostname)fsPath='//'+uri.hostname+fsPath;const trimmed=fsPath.replace(/[\\\\/]+$/u,'');const label=trimmed.split(/[\\\\/]/u).at(-1)||fsPath;descriptors.push({label,path:fsPath,fsPath});}catch{}}return descriptors;};const read=(event)=>event.dataTransfer?.getData('text/uri-list')??'';composer.addEventListener('dragover',(event)=>{if(descriptorsFromDrop(read(event)).length===0)return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';},true);composer.addEventListener('drop',(event)=>{const descriptors=descriptorsFromDrop(read(event));if(descriptors.length===0)return;event.preventDefault();event.stopImmediatePropagation();${add}(descriptors);${controller}.focus?.();},true);})()${PATCH_END_MARKER}`;
}
```

`patchBundleSource` must collect all matches first, require exactly one, retain the complete native anchor, and append the generated marked injection. `unpatchBundleSource` must require exactly one well-formed start/end marker pair and remove only that injected region.

- [ ] **Step 8: Run source tests and commit Task 1**

Run: `npx vitest run test/unit/codexDropSource.test.ts`

Expected: all source tests PASS.

```bash
git add scripts/lib/codex-drop-source.mjs test/unit/codexDropSource.test.ts
git commit -m "feat: generate Codex drop chip bundle patch"
```

### Task 2: Safe Installation Discovery, Patch, and Restore

**Files:**
- Create: `scripts/lib/codex-drop-installation.mjs`
- Create: `test/unit/codexDropInstallation.test.ts`

**Interfaces:**
- Consumes: `patchBundleSource`, an optional explicit extension directory, and standard filesystem paths.
- Produces: `discoverCodexInstallations(options)`, `resolveCodexTarget(options)`, `applyCodexDropPatch(options)`, `restoreCodexDropPatch(options)`, and metadata version 1.

- [ ] **Step 1: Write failing discovery and target-selection tests**

Create temporary fake installs named `openai.chatgpt-26.818.10000-darwin-arm64` and `openai.chatgpt-26.818.61809-darwin-arm64`, each with `package.json` and a single `webview/assets/app-initial-*.js`. Assert that discovery ignores unrelated extensions and selects `26.818.61809` using numeric version ordering. Add cases for explicit `extensionDir`, no matching installation, no matching bundle, and more than one bundle containing the composer anchor.

```ts
const target = await resolveCodexTarget({ roots: [extensionsRoot] });
expect(target.extensionVersion).toBe('26.818.61809');
expect(target.bundlePath).toBe(path.join(
  extensionsRoot,
  'openai.chatgpt-26.818.61809-darwin-arm64',
  'webview/assets/app-initial-current.js',
));
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run test/unit/codexDropInstallation.test.ts`

Expected: FAIL because the installation module does not exist.

- [ ] **Step 3: Implement discovery and strict target resolution**

Default roots are:

```js
[
  path.join(os.homedir(), '.vscode', 'extensions'),
  path.join(os.homedir(), '.vscode-insiders', 'extensions'),
]
```

Read `package.json` to require `name === 'chatgpt'` or an extension directory beginning with `openai.chatgpt-`, record its exact `version`, scan only `webview/assets/app-initial-*.js`, and select the one bundle for which the source transformer recognizes exactly one anchor. Use `Intl.Collator('en', { numeric: true })` for version ordering.

- [ ] **Step 4: Run discovery tests and confirm they pass**

Run: `npx vitest run test/unit/codexDropInstallation.test.ts`

Expected: discovery and selection cases PASS.

- [ ] **Step 5: Add failing lifecycle and safety tests**

Cover these exact transitions in temporary directories:

```ts
const first = await applyCodexDropPatch({ extensionDir });
expect(first.status).toBe('patched');
expect(await readFile(first.metadataPath, 'utf8')).toContain('"patchVersion": 1');

const second = await applyCodexDropPatch({ extensionDir });
expect(second.status).toBe('already-patched');

const restored = await restoreCodexDropPatch({ extensionDir });
expect(restored.status).toBe('restored');
expect(await readFile(bundlePath, 'utf8')).toBe(originalSource);
```

Also mutate the patched bundle after applying and assert restore rejects with `Current bundle hash does not match patch metadata`; mutate the backup and assert restore rejects with `Backup hash does not match patch metadata`.

- [ ] **Step 6: Run the focused test to verify lifecycle cases fail**

Run: `npx vitest run test/unit/codexDropInstallation.test.ts`

Expected: FAIL because apply/restore functions are missing.

- [ ] **Step 7: Implement hash-checked atomic patch and restore**

Use these adjacent paths:

```js
const backupPath = `${bundlePath}.codex-explorer-drop-chips.original`;
const metadataPath = `${bundlePath}.codex-explorer-drop-chips.json`;
```

Metadata must be formatted JSON with:

```js
{
  patchVersion: PATCH_VERSION,
  extensionVersion,
  bundlePath,
  backupPath,
  originalSha256,
  patchedSha256,
}
```

Implement `sha256(textOrBuffer)` with `createHash('sha256')`. Before any write, calculate transformed source and all paths. Write the backup with `{ flag: 'wx' }`, write metadata and patched source to sibling temporary files, then rename the patched temporary file over the bundle. If metadata installation fails before bundle replacement, leave the original bundle intact and report the backup path. Never delete a backup. Restore only after both hashes match, replace through a sibling temporary file, and keep metadata/backup as an audit trail.

- [ ] **Step 8: Run installation tests and commit Task 2**

Run: `npx vitest run test/unit/codexDropInstallation.test.ts`

Expected: all installation tests PASS.

```bash
git add scripts/lib/codex-drop-installation.mjs test/unit/codexDropInstallation.test.ts
git commit -m "feat: safely patch installed Codex webview"
```

### Task 3: Patch and Restore CLIs

**Files:**
- Create: `scripts/patch-codex-drop.mjs`
- Create: `scripts/unpatch-codex-drop.mjs`
- Create: `test/unit/codexDropCli.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: installation module apply/restore functions and optional `--extension-dir <absolute-path>`.
- Produces: stable zero/nonzero CLI status, human-readable target/status output, and npm scripts.

- [ ] **Step 1: Write failing CLI tests**

Use `spawnSync(process.execPath, [scriptPath, '--extension-dir', extensionDir], { encoding: 'utf8' })` against a temporary fake installation. Assert patch exits 0 and prints `Patched Codex 26.818.61809`; a second run exits 0 and prints `already patched`; restore exits 0 and prints `Restored Codex 26.818.61809`; malformed arguments and an incompatible installation exit 1 and print a concise error to stderr.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run test/unit/codexDropCli.test.ts`

Expected: FAIL because the CLI scripts do not exist.

- [ ] **Step 3: Implement thin argument parsing and CLI entry points**

Each script accepts no arguments or exactly `--extension-dir <path>`. Resolve the explicit path to an absolute path, call the matching installation function, print the extension version, bundle path, status, and `Reload VS Code to use the updated Codex webview.` after a real patch or restore. Catch errors once, print `Codex drop patch failed: <message>` or `Codex drop restore failed: <message>`, and set `process.exitCode = 1`.

- [ ] **Step 4: Add npm scripts**

Modify `package.json`:

```json
"patch:codex-drop": "node ./scripts/patch-codex-drop.mjs",
"unpatch:codex-drop": "node ./scripts/unpatch-codex-drop.mjs"
```

- [ ] **Step 5: Run CLI and manifest tests**

Run: `npx vitest run test/unit/codexDropCli.test.ts test/unit/manifest.test.ts`

Expected: all CLI and manifest tests PASS. If the manifest exact-script assertions require updating, add only the two new expected script values.

- [ ] **Step 6: Commit Task 3**

```bash
git add package.json scripts/patch-codex-drop.mjs scripts/unpatch-codex-drop.mjs test/unit/codexDropCli.test.ts test/unit/manifest.test.ts
git commit -m "feat: add Codex drop patch commands"
```

### Task 4: User Documentation and Repository Verification

**Files:**
- Modify: `README.md`
- Modify if package contents change: `test/unit/packageRuntime.test.ts`

**Interfaces:**
- Consumes: `npm run patch:codex-drop` and `npm run unpatch:codex-drop`.
- Produces: update-safe operating instructions and a fully verified repository.

- [ ] **Step 1: Add a failing documentation assertion**

Add a focused assertion to an existing documentation/packaging test or a new case in `test/unit/packageRuntime.test.ts` that requires README text containing both commands, the exact extension glob `openai.chatgpt-*`, and the phrase `Reload VS Code`.

- [ ] **Step 2: Run the documentation assertion to verify it fails**

Run: `npx vitest run test/unit/packageRuntime.test.ts`

Expected: FAIL because README does not document the patch workflow.

- [ ] **Step 3: Document install, update, and restore workflow**

Add a `Codex Explorer drop chips` section explaining:

```bash
npm run patch:codex-drop
# Reload VS Code, then drop Explorer files or folders onto the Codex composer.

npm run unpatch:codex-drop
# Reload VS Code again after restoring.
```

State that each file or folder becomes one chip, directories are not expanded, the command patches the newest compatible `openai.chatgpt-*` installation, Codex updates require rerunning the patch command, and an unknown bundle layout fails without modifying the installation.

- [ ] **Step 4: Run full repository verification**

Run: `npm run check`

Expected: TypeScript compilation succeeds and all unit tests PASS.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 5: Commit Task 4**

```bash
git add README.md test/unit/packageRuntime.test.ts
git commit -m "docs: explain Codex Explorer drop patch"
```

### Task 5: Apply to the Current Codex Installation and Verify Artifacts

**Files:**
- External target after explicit sandbox approval: newest compatible `~/.vscode/extensions/openai.chatgpt-*/webview/assets/app-initial-*.js`
- External generated backup and metadata adjacent to that bundle.

**Interfaces:**
- Consumes: completed, passing patch CLI.
- Produces: one locally patched Codex installation plus recoverable backup metadata.

- [ ] **Step 1: Dry-run target resolution through the tested library**

Run a read-only Node invocation that imports `resolveCodexTarget()` and prints the exact extension version and bundle path.

Expected: exactly one target under the newest installed Codex extension, currently `26.818.61809` unless the extension updates before execution.

- [ ] **Step 2: Apply the patch with external-write approval**

Run: `npm run patch:codex-drop`

Expected: `Patched Codex <version>`, the exact bundle path, the backup/metadata paths, and a reload instruction. Because the command writes outside the workspace, request sandbox escalation for this exact npm script.

- [ ] **Step 3: Verify installed hashes and idempotence**

Run: `npm run patch:codex-drop`

Expected: exit 0 with `already patched`, and the bundle hash remains unchanged between the first and second command.

Run: `npm run check`

Expected: all repository checks still PASS after the external patch.

- [ ] **Step 4: Hand off the manual UI check**

Tell the user to reload VS Code and verify:

1. Drop one file: one native chip appears and no raw URI text appears.
2. Drop one directory: one directory-path chip appears; its children are not expanded.
3. Drop mixed multiple items: one chip appears per selected Explorer item.
4. Drop unsupported non-file content: normal Codex behavior remains unchanged.

Do not claim the UI behavior is manually verified until the user confirms these results.

- [ ] **Step 5: Commit any compatibility correction only after focused regression coverage**

If the live bundle exposes a verified compatibility difference, first add a fixture reproducing that exact bundle anchor shape, run the focused test red, make the minimal transformer change, run focused and full checks green, then commit:

```bash
git add scripts/lib/codex-drop-source.mjs test/unit/codexDropSource.test.ts
git commit -m "fix: support current Codex composer bundle"
```
