# Codex Webview Cache Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure VS Code loads the already-patched Codex webview bundle by installing a scoped, one-time cache-clearing entry bootstrap before the original Codex entry module.

**Architecture:** A new pure source module transforms `webview/index.html` and generates a versioned browser bootstrap whose behavior is dependency-injected for unit testing. The existing installation module coordinates the bundle, index, bootstrap, backups, hash-checked schema migration, and restoration while retaining bundle patch version 6.

**Tech Stack:** Node.js ESM, browser Cache Storage and sessionStorage APIs, TypeScript/Vitest fixtures, SHA-256 via `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-08-25-codex-webview-cache-bootstrap-design.md`

## Global Constraints

- Cache invalidation must be limited to the current Codex webview origin. The installer must not remove global VS Code cache directories.
- The cache bootstrap must run before the original Codex entry module so stale application modules cannot execute during the invalidation load.
- Cache invalidation must cause at most one automatic webview reload per bootstrap version and webview session.
- The Codex application must still load if the Cache Storage API is unavailable or deletion fails.
- The implementation must support the currently installed, verified v6 bundle patch without requiring the user to restore it first.
- Installation and restoration must remain reversible and fail closed on unsupported Codex layouts or changed files.
- No new runtime dependency is allowed.
- Existing unrelated worktree changes, including the package version change, remain untouched.

---

## File Structure

- Create `scripts/lib/codex-webview-cache-source.mjs`: pure index transformation, inverse transformation, dependency-injected bootstrap behavior, and browser module generation.
- Create `test/unit/codexWebviewCacheSource.test.ts`: index transformation and browser bootstrap behavior tests.
- Modify `scripts/lib/codex-drop-installation.mjs`: expanded target paths, metadata schema 2, legacy migration, multi-artifact install, and safe restore.
- Modify `test/unit/codexDropInstallation.test.ts`: realistic index fixture, fresh install, legacy migration, restore, idempotence, and tamper tests.
- Modify `test/unit/codexDropCli.test.ts`: realistic index fixture and updated cache-refresh messages.
- Modify `scripts/patch-codex-drop.mjs`: report the one-time refresh behavior.
- Modify `scripts/unpatch-codex-drop.mjs`: report reload requirements after restoring both webview targets.

### Task 1: Pure Index and Cache-Bootstrap Source

**Files:**
- Create: `scripts/lib/codex-webview-cache-source.mjs`
- Create: `test/unit/codexWebviewCacheSource.test.ts`

**Interfaces:**
- Consumes: original Codex `index.html`, the original entry-module `src`, and browser API adapters.
- Produces: `patchIndexSource(source) -> {status, source, entrySource}`, `unpatchIndexSource(source) -> {status, source}`, `executeCacheBootstrap(dependencies) -> Promise<'reloaded'|'imported'|'fallback'>`, `createBootstrapSource(entrySource) -> string`, plus cache-bootstrap constants.

- [ ] **Step 1: Write failing index transformation tests**

Create `test/unit/codexWebviewCacheSource.test.ts` with the representative production structure and strict failure cases:

```ts
import { describe, expect, it, vi } from 'vitest';

const entryTag = '<script type="module" crossorigin src="./assets/index-current.js"></script>';
const indexSource = [
  '<!doctype html><head>',
  '<!-- PROD_CSP_TAG_HERE -->',
  entryTag,
  '<link rel="modulepreload" crossorigin href="./assets/app-initial-current.js">',
  '<link rel="stylesheet" href="./assets/app.css">',
  '</head><body><div id="root"></div></body>',
].join('\n');

describe('Codex webview cache source', () => {
  it('replaces only the production entry module and restores exact HTML', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { BOOTSTRAP_ASSET_URL, patchIndexSource, unpatchIndexSource } = await import(
      '../../scripts/lib/codex-webview-cache-source.mjs'
    );
    const patched = patchIndexSource(indexSource);
    expect(patched.status).toBe('patched');
    expect(patched.entrySource).toBe('./assets/index-current.js');
    expect(patched.source).toContain(`src="${BOOTSTRAP_ASSET_URL}"`);
    expect(patched.source).toContain('./assets/app-initial-current.js');
    expect(patched.source).toContain('./assets/app.css');
    expect(unpatchIndexSource(patched.source)).toEqual({ status: 'restored', source: indexSource });
  });

  it('is idempotent for one valid marker pair', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchIndexSource } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const first = patchIndexSource(indexSource);
    expect(patchIndexSource(first.source)).toEqual({
      status: 'already-patched',
      source: first.source,
      entrySource: './assets/index-current.js',
    });
  });

  it.each([
    ['missing entry', '<html><head></head></html>'],
    ['duplicate entry', `${entryTag}${entryTag}`],
  ])('rejects %s', async (_name, source) => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchIndexSource } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    expect(() => patchIndexSource(source)).toThrow(/exactly one Codex webview entry module/u);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `npx vitest run test/unit/codexWebviewCacheSource.test.ts`

Expected: FAIL because `scripts/lib/codex-webview-cache-source.mjs` does not exist.

- [ ] **Step 3: Implement strict index transformation and inverse transformation**

Create `scripts/lib/codex-webview-cache-source.mjs` with these public constants and marker rules:

```js
export const CACHE_BOOTSTRAP_VERSION = 1;
export const BOOTSTRAP_ASSET_NAME = `codex-explorer-drop-cache-bootstrap-v${CACHE_BOOTSTRAP_VERSION}.js`;
export const BOOTSTRAP_ASSET_URL = `./assets/${BOOTSTRAP_ASSET_NAME}`;
export const INDEX_START_MARKER = `<!-- codex-explorer-drop-cache:start:v${CACHE_BOOTSTRAP_VERSION} -->`;
export const INDEX_END_MARKER = `<!-- codex-explorer-drop-cache:end:v${CACHE_BOOTSTRAP_VERSION} -->`;

const ENTRY_MODULE = /<script\s+type="module"\s+crossorigin\s+src="(?<source>\.\/assets\/index-[^"]+\.js)"><\/script>/gu;
```

`patchIndexSource` must count every supported or legacy marker before matching the entry. For one match, base64-encode the complete original tag inside the marker block and replace only that tag:

```js
const encodedTag = Buffer.from(match[0], 'utf8').toString('base64');
const replacement = `${INDEX_START_MARKER}<script type="module" crossorigin src="${BOOTSTRAP_ASSET_URL}"></script><!-- codex-explorer-drop-cache:original:${encodedTag} -->${INDEX_END_MARKER}`;
```

`unpatchIndexSource` must require one ordered marker pair, decode the embedded original tag, and replace exactly that marked block. Unsupported versions, duplicates, reversed markers, missing embedded originals, missing entry tags, and duplicate entry tags throw descriptive errors.

- [ ] **Step 4: Run the focused tests and confirm the transformation cases pass**

Run: `npx vitest run test/unit/codexWebviewCacheSource.test.ts`

Expected: transformation, idempotence, restore, missing-entry, and duplicate-entry tests PASS.

- [ ] **Step 5: Add failing dependency-injected bootstrap behavior tests**

Append these core runtime cases to `test/unit/codexWebviewCacheSource.test.ts`:

```ts
it('clears current-origin caches and reloads without importing on the first load', async () => {
  // @ts-expect-error Script modules are intentionally JavaScript-only.
  const { CACHE_STATE_KEY, executeCacheBootstrap } = await import(
    '../../scripts/lib/codex-webview-cache-source.mjs'
  );
  const values = new Map<string, string>();
  const deleteCache = vi.fn(async () => true);
  const reload = vi.fn();
  const importEntry = vi.fn(async () => undefined);

  await expect(executeCacheBootstrap({
    cacheStorage: { keys: async () => ['one', 'two'], delete: deleteCache },
    storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
    reload,
    importEntry,
    reportError: vi.fn(),
  })).resolves.toBe('reloaded');

  expect(deleteCache.mock.calls).toEqual([['one'], ['two']]);
  expect(values.get(CACHE_STATE_KEY)).toBe('ready');
  expect(reload).toHaveBeenCalledOnce();
  expect(importEntry).not.toHaveBeenCalled();
});

it('imports immediately after a successful refresh', async () => {
  // @ts-expect-error Script modules are intentionally JavaScript-only.
  const { executeCacheBootstrap } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
  const importEntry = vi.fn(async () => undefined);
  await expect(executeCacheBootstrap({
    cacheStorage: { keys: vi.fn(), delete: vi.fn() },
    storage: { getItem: () => 'ready', setItem: vi.fn() },
    reload: vi.fn(),
    importEntry,
    reportError: vi.fn(),
  })).resolves.toBe('imported');
  expect(importEntry).toHaveBeenCalledOnce();
});

it.each([
  ['missing Cache Storage', undefined],
  ['cache enumeration rejection', { keys: async () => { throw new Error('cache unavailable'); }, delete: vi.fn() }],
  ['cache deletion rejection', { keys: async () => ['one'], delete: async () => { throw new Error('delete failed'); } }],
])('falls back to the app without a reload for %s', async (_name, cacheStorage) => {
  // @ts-expect-error Script modules are intentionally JavaScript-only.
  const { CACHE_STATE_KEY, executeCacheBootstrap } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
  const values = new Map<string, string>();
  const reload = vi.fn();
  const importEntry = vi.fn(async () => undefined);
  const reportError = vi.fn();
  await expect(executeCacheBootstrap({
    cacheStorage,
    storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
    reload,
    importEntry,
    reportError,
  })).resolves.toBe('fallback');
  expect(values.get(CACHE_STATE_KEY)).toBe('failed');
  expect(reload).not.toHaveBeenCalled();
  expect(importEntry).toHaveBeenCalledOnce();
  expect(reportError).toHaveBeenCalledOnce();
});
```

Add the failed-state retry guard explicitly:

```ts
it('does not retry cache deletion after a recorded failure', async () => {
  // @ts-expect-error Script modules are intentionally JavaScript-only.
  const { executeCacheBootstrap } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
  const keys = vi.fn();
  const reload = vi.fn();
  const importEntry = vi.fn(async () => undefined);
  await expect(executeCacheBootstrap({
    cacheStorage: { keys, delete: vi.fn() },
    storage: { getItem: () => 'failed', setItem: vi.fn() },
    reload,
    importEntry,
    reportError: vi.fn(),
  })).resolves.toBe('fallback');
  expect(keys).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  expect(importEntry).toHaveBeenCalledOnce();
});
```

- [ ] **Step 6: Run the focused test and verify the missing bootstrap exports**

Run: `npx vitest run test/unit/codexWebviewCacheSource.test.ts`

Expected: FAIL because `CACHE_STATE_KEY`, `executeCacheBootstrap`, and `createBootstrapSource` are not implemented.

- [ ] **Step 7: Implement bootstrap behavior and generated browser module**

Use this dependency contract so the behavior is testable without a DOM:

```js
export const CACHE_STATE_KEY = `codex-explorer-drop-cache:v${CACHE_BOOTSTRAP_VERSION}`;

export async function executeCacheBootstrap({ cacheStorage, storage, reload, importEntry, reportError }) {
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
}
```

`createBootstrapSource(entrySource)` must serialize `executeCacheBootstrap` into a standalone module and preserve the HTML-relative meaning of the captured entry URL:

```js
const entryLiteral = JSON.stringify(entrySource);
const behaviorSource = executeCacheBootstrap.toString();
return `const CACHE_STATE_KEY=${JSON.stringify(CACHE_STATE_KEY)};const executeCacheBootstrap=${behaviorSource};const entryUrl=new URL(${entryLiteral},document.baseURI).href;await executeCacheBootstrap({cacheStorage:globalThis.caches,storage:globalThis.sessionStorage,reload:()=>globalThis.location.reload(),importEntry:()=>import(entryUrl),reportError:(error)=>console.error('Codex drop cache refresh failed',error)});\n`;
```

Add an assertion that generated source contains the captured entry, versioned key, `document.baseURI`, and no filesystem/cache-directory path.

- [ ] **Step 8: Run Task 1 tests and commit**

Run: `npx vitest run test/unit/codexWebviewCacheSource.test.ts`

Expected: all Task 1 tests PASS.

```bash
git add scripts/lib/codex-webview-cache-source.mjs test/unit/codexWebviewCacheSource.test.ts
git commit -m "feat: add Codex webview cache bootstrap source"
```

### Task 2: Fresh Installation and Legacy-v6 Migration

**Files:**
- Modify: `scripts/lib/codex-drop-installation.mjs`
- Modify: `test/unit/codexDropInstallation.test.ts`

**Interfaces:**
- Consumes: Task 1 exports and existing bundle patch metadata.
- Produces: metadata schema 2 with bundle/index/bootstrap paths and hashes; `applyCodexDropPatch(options)` returning `status: 'patched'|'already-patched'|'migrated'` and all managed paths.

- [ ] **Step 1: Upgrade the fake installation fixture and write failing fresh-install assertions**

In `makeInstallation`, add a realistic webview index after creating `webview/assets`:

```ts
const indexSource = [
  '<!doctype html><html><head>',
  '<!-- PROD_CSP_TAG_HERE -->',
  '<script type="module" crossorigin src="./assets/index-current.js"></script>',
  '<link rel="modulepreload" crossorigin href="./assets/app-initial-current.js">',
  '</head><body><div id="root"></div></body></html>',
].join('\n');
await writeFile(path.join(extensionDir, 'webview/index.html'), indexSource);
```

Extend the lifecycle test after the first patch:

```ts
expect(first.status).toBe('patched');
expect(first.indexPath).toBe(path.join(extensionDir, 'webview/index.html'));
expect(first.bootstrapPath).toBe(path.join(extensionDir, 'webview/assets/codex-explorer-drop-cache-bootstrap-v1.js'));
const metadata = JSON.parse(await readFile(first.metadataPath, 'utf8'));
expect(metadata.metadataSchemaVersion).toBe(2);
expect(metadata.patchVersion).toBe(6);
expect(metadata.cacheBootstrapVersion).toBe(1);
expect(await readFile(first.indexPath, 'utf8')).toContain('codex-explorer-drop-cache-bootstrap-v1.js');
expect(await readFile(first.bootstrapPath, 'utf8')).toContain('./assets/index-current.js');
```

- [ ] **Step 2: Run the lifecycle test and verify missing index/bootstrap fields**

Run: `npx vitest run test/unit/codexDropInstallation.test.ts -t "patches, restores"`

Expected: FAIL because the result and metadata do not contain index/bootstrap artifacts.

- [ ] **Step 3: Add schema-2 paths, metadata, source generation, and staged installation**

Import Task 1:

```js
import {
  BOOTSTRAP_ASSET_NAME,
  CACHE_BOOTSTRAP_VERSION,
  createBootstrapSource,
  patchIndexSource,
} from './codex-webview-cache-source.mjs';

const METADATA_SCHEMA_VERSION = 2;
```

Expand `patchPaths(bundlePath)` using the extension layout derived from the bundle:

```js
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
```

Schema-2 metadata must include exact names:

```js
{
  metadataSchemaVersion: 2,
  patchVersion: PATCH_VERSION,
  cacheBootstrapVersion: CACHE_BOOTSTRAP_VERSION,
  extensionVersion,
  bundlePath,
  backupPath,
  originalSha256,
  patchedSha256,
  indexPath,
  indexBackupPath,
  originalIndexSha256,
  patchedIndexSha256,
  bootstrapPath,
  bootstrapSha256,
  entrySource,
}
```

Before any target rename, read and transform bundle/index, generate bootstrap source, validate existing backups/metadata, and stage every new file with `writeTemporary`. Fresh installation writes original backups with `flag: 'wx'`. Rename the bootstrap first, index second, bundle third, and metadata last; on a rename failure, restore changed targets from verified backups and remove only the generated bootstrap whose staged or installed hash matches.

- [ ] **Step 4: Run fresh-install tests and confirm they pass**

Run: `npx vitest run test/unit/codexDropInstallation.test.ts -t "patches, restores"`

Expected: fresh patch assertions pass; restore assertions may still fail until Task 3.

- [ ] **Step 5: Add a failing legacy-v6 migration test**

Create a temporary installation, apply the existing bundle-only state manually, and assert migration does not rewrite its validated bundle or backup:

```ts
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
```

Import `patchBundleSource`, `sha256`, and required `readFile` helpers explicitly in the test.

- [ ] **Step 6: Run the migration test and verify the old already-patched result**

Run: `npx vitest run test/unit/codexDropInstallation.test.ts -t "migrates"`

Expected: FAIL because legacy metadata currently returns `already-patched` and does not install the index/bootstrap.

- [ ] **Step 7: Implement legacy metadata discrimination and migration**

Split validation into `assertLegacyMetadataShape` and `assertSchema2MetadataShape`. A record without `metadataSchemaVersion` is legacy only when every existing v6 bundle field and hash is valid. During migration:

1. validate the current patched bundle and original backup against legacy hashes;
2. require an unpatched compatible index and create its original backup;
3. generate/write bootstrap and patched index;
4. write schema-2 metadata last;
5. return `status: 'migrated'`.

A schema-2 reapply validates all current hashes and returns `already-patched`. Any partial index/bootstrap state without valid schema-2 metadata fails closed.

- [ ] **Step 8: Run installation tests and commit Task 2**

Run: `npx vitest run test/unit/codexDropInstallation.test.ts`

Expected: discovery, fresh installation, idempotence, migration, and pre-existing bundle safety tests PASS; expanded restore tests are added next.

```bash
git add scripts/lib/codex-drop-installation.mjs test/unit/codexDropInstallation.test.ts
git commit -m "feat: install Codex cache bootstrap safely"
```

### Task 3: Expanded and Legacy Restore Safety

**Files:**
- Modify: `scripts/lib/codex-drop-installation.mjs`
- Modify: `test/unit/codexDropInstallation.test.ts`

**Interfaces:**
- Consumes: schema-2 or legacy metadata selected by `findRestoreTarget`.
- Produces: `restoreCodexDropPatch(options)` that restores both targets and removes only a hash-verified patch-owned bootstrap for schema 2, or restores only the bundle for legacy metadata.

- [ ] **Step 1: Write failing expanded restore assertions**

Capture original index bytes before patching, then extend the main lifecycle test:

```ts
const indexPath = path.join(extensionDir, 'webview/index.html');
const originalIndex = await readFile(indexPath);
const first = await applyCodexDropPatch({ extensionDir });
const restored = await restoreCodexDropPatch({ extensionDir });
expect(restored.status).toBe('restored');
expect(await readFile(bundlePath)).toEqual(originalBundle);
expect(await readFile(indexPath)).toEqual(originalIndex);
await expect(readFile(first.bootstrapPath)).rejects.toMatchObject({ code: 'ENOENT' });
const secondRestore = await restoreCodexDropPatch({ extensionDir });
expect(secondRestore.status).toBe('already-restored');
```

- [ ] **Step 2: Run the expanded restore test and verify index/bootstrap remain patched**

Run: `npx vitest run test/unit/codexDropInstallation.test.ts -t "patches, restores"`

Expected: FAIL because current restore only restores the bundle.

- [ ] **Step 3: Implement preflight validation and coordinated schema-2 restore**

Before creating temporary restore files, validate:

```js
assertCurrentMatches(currentBundleHash, metadata.originalSha256, metadata.patchedSha256, 'bundle');
assertCurrentMatches(currentIndexHash, metadata.originalIndexSha256, metadata.patchedIndexSha256, 'index');
if (sha256(originalBundle) !== metadata.originalSha256) throw new Error('Backup hash does not match patch metadata');
if (sha256(originalIndex) !== metadata.originalIndexSha256) throw new Error('Index backup hash does not match patch metadata');
if (bootstrapExists && sha256(currentBootstrap) !== metadata.bootstrapSha256) {
  throw new Error('Bootstrap hash does not match patch metadata');
}
```

If either target is patched, stage both originals, rename index and bundle, and roll back the first rename if the second fails. Remove `bootstrapPath` only after both targets are original and only if its hash matched. Missing bootstrap is allowed only when both targets are already original; otherwise it is a partial-state error. Preserve backup and metadata files.

- [ ] **Step 4: Add and run tamper tests**

Add table-driven cases that modify one artifact after a fresh patch:

```ts
it.each([
  ['bundle', (result) => result.bundlePath, 'Current bundle hash does not match patch metadata'],
  ['index', (result) => result.indexPath, 'Current index hash does not match patch metadata'],
  ['bundle backup', (result) => result.backupPath, 'Backup hash does not match patch metadata'],
  ['index backup', (result) => result.indexBackupPath, 'Index backup hash does not match patch metadata'],
  ['bootstrap', (result) => result.bootstrapPath, 'Bootstrap hash does not match patch metadata'],
])('refuses restore after %s changes', async (_name, selectPath, expected) => {
  const extensionsRoot = await makeTemporaryDirectory();
  const extensionDir = await makeInstallation(extensionsRoot, '26.818.61809');
  const result = await applyCodexDropPatch({ extensionDir });
  await writeFile(selectPath(result), 'modified after patching');
  await expect(restoreCodexDropPatch({ extensionDir })).rejects.toThrow(expected);
});
```

Run: `npx vitest run test/unit/codexDropInstallation.test.ts`

Expected: all tamper cases PASS without modifying either installed target.

- [ ] **Step 5: Add a failing legacy restore compatibility test**

Build the same bundle-only legacy fixture used in Task 2, call restore directly, and assert the exact original bundle returns while `index.html` stays byte-for-byte unchanged and no bootstrap is created.

Run: `npx vitest run test/unit/codexDropInstallation.test.ts -t "legacy metadata"`

Expected: FAIL if metadata dispatch assumes schema 2.

- [ ] **Step 6: Implement legacy restore dispatch and run all lifecycle tests**

Dispatch after parsing metadata:

```js
if (metadata.metadataSchemaVersion === undefined) {
  return restoreLegacyBundlePatch(target, paths, metadata);
}
return restoreSchema2Patch(target, paths, metadata);
```

The legacy helper retains the existing current/backup hash checks and bundle-only atomic rename. It must not read, patch, or restore `index.html`.

Run: `npx vitest run test/unit/codexDropInstallation.test.ts`

Expected: every installation discovery, fresh lifecycle, migration, schema-2 restore, legacy restore, and tamper test PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add scripts/lib/codex-drop-installation.mjs test/unit/codexDropInstallation.test.ts
git commit -m "fix: restore Codex cache bootstrap artifacts"
```

### Task 4: CLI Contract and Automated Verification

**Files:**
- Modify: `scripts/patch-codex-drop.mjs`
- Modify: `scripts/unpatch-codex-drop.mjs`
- Modify: `test/unit/codexDropCli.test.ts`

**Interfaces:**
- Consumes: `patched`, `migrated`, `already-patched`, `restored`, and `already-restored` lifecycle results.
- Produces: concise user-facing status plus exact VS Code reload/cache-refresh instructions.

- [ ] **Step 1: Upgrade the CLI fixture and write failing output assertions**

Make the CLI fixture create the same `webview/index.html` from Task 2. Extend the success test:

```ts
expect(firstPatch.stdout).toContain('Patched Codex 26.818.61809');
expect(firstPatch.stdout).toContain('The first Codex webview load will refresh its cache once.');
expect(firstPatch.stdout).toContain('Reload VS Code');

const secondPatch = run(patchScript, '--extension-dir', extensionDir);
expect(secondPatch.stdout).toContain('already patched');

const restore = run(restoreScript, '--extension-dir', extensionDir);
expect(restore.stdout).toContain('Restored Codex 26.818.61809');
expect(restore.stdout).toContain('Reload VS Code');
```

Add a CLI migration fixture with validated legacy metadata and expect `Migrated Codex 26.818.61809`.

- [ ] **Step 2: Run CLI tests and verify missing fixture/output behavior**

Run: `npx vitest run test/unit/codexDropCli.test.ts`

Expected: FAIL because the fixture lacks the new index and the CLI has no migration/cache-refresh messages.

- [ ] **Step 3: Implement result-specific CLI messages**

In `scripts/patch-codex-drop.mjs`, use this status mapping:

```js
if (result.status === 'patched') console.log(`Patched Codex ${result.extensionVersion}`);
else if (result.status === 'migrated') console.log(`Migrated Codex ${result.extensionVersion}`);
else console.log(`Codex ${result.extensionVersion} is already patched`);
console.log(`Bundle: ${result.bundlePath}`);
console.log(`Index: ${result.indexPath}`);
console.log(`Status: ${result.status}`);
if (result.status !== 'already-patched') {
  console.log('Reload VS Code to use the updated Codex webview.');
  console.log('The first Codex webview load will refresh its cache once.');
}
```

The restore CLI prints bundle and index paths for schema 2, omits an undefined index for legacy restoration, and retains the reload instruction for `restored`.

- [ ] **Step 4: Run focused CLI and Codex-drop tests**

Run: `npx vitest run test/unit/codexWebviewCacheSource.test.ts test/unit/codexDropSource.test.ts test/unit/codexDropInstallation.test.ts test/unit/codexDropCli.test.ts`

Expected: all cache source, drop source, lifecycle, and CLI tests PASS.

- [ ] **Step 5: Run repository verification**

Run: `npm run check`

Expected: TypeScript compilation succeeds and the complete unit suite passes with exit code 0.

- [ ] **Step 6: Review the diff and commit Task 4**

Run: `git diff --check`

Expected: no whitespace errors.

```bash
git add scripts/patch-codex-drop.mjs scripts/unpatch-codex-drop.mjs test/unit/codexDropCli.test.ts
git commit -m "fix: report Codex webview cache refresh"
```

### Task 5: Install Into the Current Codex Extension and Verify Disk State

**Files:**
- External target after explicit approval: `/Users/yumyeongjun/.vscode/extensions/openai.chatgpt-26.818.61809-darwin-arm64/webview/index.html`
- External generated asset after explicit approval: `/Users/yumyeongjun/.vscode/extensions/openai.chatgpt-26.818.61809-darwin-arm64/webview/assets/codex-explorer-drop-cache-bootstrap-v1.js`
- Existing external bundle/metadata/backup under the same Codex extension installation.

**Interfaces:**
- Consumes: verified repository patch command and the currently installed legacy-v6 patch state.
- Produces: a schema-2 installed patch whose bundle, index, bootstrap, backups, and metadata all match recorded hashes.

- [ ] **Step 1: Apply the verified migration to the explicit Codex installation**

Run with external-write approval:

```bash
npm run patch:codex-drop -- --extension-dir /Users/yumyeongjun/.vscode/extensions/openai.chatgpt-26.818.61809-darwin-arm64
```

Expected: exit code 0, `Migrated Codex 26.818.61809`, index/bootstrap paths, and the one-time refresh notice.

- [ ] **Step 2: Re-run the patch command to prove installed idempotence**

Run the same command again.

Expected: exit code 0 and `Codex 26.818.61809 is already patched` with no target hash changes.

- [ ] **Step 3: Verify installed metadata and hashes without modifying files**

Run this read-only verifier against the installed metadata:

```bash
node --input-type=module -e 'import { readFile } from "node:fs/promises"; import { createHash } from "node:crypto"; const metadata=JSON.parse(await readFile(process.argv[1],"utf8")); if(metadata.metadataSchemaVersion!==2) throw new Error("Expected metadata schema 2"); const hash=async(file)=>createHash("sha256").update(await readFile(file)).digest("hex"); const checks=[[metadata.bundlePath,metadata.patchedSha256],[metadata.backupPath,metadata.originalSha256],[metadata.indexPath,metadata.patchedIndexSha256],[metadata.indexBackupPath,metadata.originalIndexSha256],[metadata.bootstrapPath,metadata.bootstrapSha256]]; for(const [file,expected] of checks) if(await hash(file)!==expected) throw new Error(`Hash mismatch: ${file}`); console.log("Codex drop cache bootstrap verified");' /Users/yumyeongjun/.vscode/extensions/openai.chatgpt-26.818.61809-darwin-arm64/webview/assets/app-initial-B_qRiqxL.js.codex-explorer-drop-chips.json
```

Expected: print `Codex drop cache bootstrap verified` and exit code 0.

- [ ] **Step 4: Hand off the manual webview behavior check**

Tell the user to reload VS Code, open Codex, wait for the one automatic webview refresh, then drag these Explorer items without Shift:

- `CHANGELOG.md` expects visible `[CHANGELOG.md](CHANGELOG.md)` text;
- `test/unit` expects visible `[unit](test/unit/)` text;
- neither drop creates an attachment card.

If the automatic refresh or expected drop behavior does not occur, collect Codex webview developer-console errors before changing the patch again.
