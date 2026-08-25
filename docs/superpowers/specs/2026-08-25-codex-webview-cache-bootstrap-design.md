# Codex Webview Cache Bootstrap Design

## Goal

Make the existing Codex Explorer-drop patch execute reliably even when VS Code has cached the original Codex webview JavaScript under the same hashed asset URL.

After installation and one VS Code reload, dragging a file or directory from the Explorer onto the Codex composer must work without Shift, must not create a native attachment card, and must insert visible Markdown text such as `[CHANGELOG.md](CHANGELOG.md)` or `[unit](test/unit/)`.

## Problem Statement

The current patch modifies an installed `app-initial-*.js` file in place. Its filename and webview URL do not change. VS Code's webview service worker caches successful responses by full URL and can continue serving the previous bytes after the extension file changes. The installed bundle can therefore have the expected patch marker and hash while the running Codex webview still executes the old drop handler.

This behavior matches the cache persistence described in [microsoft/vscode#325767](https://github.com/microsoft/vscode/issues/325767) and [microsoft/vscode#320928](https://github.com/microsoft/vscode/issues/320928). Reloading the panel or VS Code is not a sufficient invalidation mechanism when the URL remains unchanged.

## Constraints

- Cache invalidation must be limited to the current Codex webview origin. The installer must not remove global VS Code cache directories.
- The cache bootstrap must run before the original Codex entry module so stale application modules cannot execute during the invalidation load.
- Cache invalidation must cause at most one automatic webview reload per bootstrap version and webview session.
- The Codex application must still load if the Cache Storage API is unavailable or deletion fails.
- The implementation must support the currently installed, verified v6 bundle patch without requiring the user to restore it first.
- Installation and restoration must remain reversible and fail closed on unsupported Codex layouts or changed files.
- No new runtime dependency is allowed.
- Existing unrelated worktree changes, including the package version change, are outside this feature's scope.

## Considered Approaches

### Selected: Versioned Entry Bootstrap

Replace the single production entry-module tag in `webview/index.html` with a tag for a newly generated, uniquely named bootstrap module. On its first execution, the bootstrap deletes Cache Storage entries visible to the current webview origin, records completion in `sessionStorage`, and reloads the webview without importing the application. On the second load it imports the original entry module.

This approach is scoped, repeatable, and ensures invalidation finishes before Codex application code executes.

### Rejected: Global VS Code Cache Cleanup

Moving or deleting VS Code's `CacheStorage`, `Cache`, and `Code Cache` directories can force fresh assets, but it requires a complete VS Code shutdown and affects unrelated extensions and webviews. It is unsuitable as the normal installation path.

### Rejected: Rename the Existing Module Graph

Changing the patched bundle filename would require rewriting the entry module and the many generated chunks that import the original hashed filename. This couples the patcher to the entire build graph and substantially increases update risk.

## Architecture

The feature has three independently testable transformations:

1. The existing bundle transformation installs the v6 composer drop handler.
2. A new HTML transformation finds exactly one production entry-module tag, preserves its original `src`, and replaces it with the versioned bootstrap module tag.
3. A bootstrap-source generator produces a browser-only module that owns the one-time cache invalidation and subsequent entry import.

The installation layer coordinates those transformations, backups, hashes, metadata migration, and restoration. Browser behavior remains isolated from Node filesystem behavior so it can be tested with a small fake `caches`, `sessionStorage`, `location`, and importer harness.

## Components

### Webview Bootstrap Source

The generated file lives under `webview/assets/` and has a patch-owned name containing the cache-bootstrap version, for example `codex-explorer-drop-cache-bootstrap-v1.js`. A version change must use a new filename so an older cached bootstrap cannot mask new behavior.

The module uses a versioned `sessionStorage` key with three states:

- no value: cache invalidation has not run in this webview session;
- `ready`: invalidation succeeded and the next load may import the original entry;
- `failed`: invalidation failed and the application should load without another reload attempt.

When no value is present, the module:

1. calls `caches.keys()`;
2. calls `caches.delete(name)` for every returned cache name;
3. writes `ready` only after all deletion promises settle successfully;
4. calls `location.reload()`;
5. does not import the Codex entry module on that load.

When the state is `ready`, it imports the exact entry-module URL captured from the original HTML. When the state is `failed`, it also imports the original entry module so Codex remains usable.

If Cache Storage is missing or any cache operation rejects, the module writes `failed`, reports one concise error through `console.error`, and imports the original entry without reloading. The bootstrap never accesses filesystem paths or VS Code-wide cache locations.

### Index HTML Transformation

The pure HTML transformation accepts the original index source and bootstrap asset URL. It requires exactly one external `<script type="module" ... src="./assets/index-*.js"></script>` entry tag. It replaces only that tag and records the original entry `src`; module-preload links, stylesheets, CSP placeholders, and document content remain byte-for-byte unchanged.

The replacement uses an external same-origin module rather than inline JavaScript, preserving the existing CSP model. A versioned start/end marker makes patched and malformed states distinguishable. Reapplying the identical transformation is idempotent; unknown marker versions, duplicate markers, missing entry tags, or multiple matching entry tags are errors.

The inverse transformation restores the exact original entry tag embedded in the marker block. Restoration still validates the complete original `index.html` backup hash rather than trusting the embedded fragment alone.

### Installation Metadata

The metadata schema is extended without changing `PATCH_VERSION = 6`, because the existing composer bundle bytes remain the approved v6 transformation. New metadata records:

- a metadata schema version;
- bundle path, backup path, original hash, and patched hash;
- index path, backup path, original hash, and patched hash;
- bootstrap path and bootstrap hash;
- cache-bootstrap version and original entry-module source.

Fresh installation backs up both the bundle and `index.html`, writes the bootstrap, patches both targets, and records all hashes.

When the bundle is already v6-patched with valid legacy metadata, installation validates the current bundle, original bundle backup, and legacy hashes first. It then backs up and patches `index.html`, writes the bootstrap, and atomically replaces the metadata with the expanded schema. It does not rewrite the already-correct bundle or replace its original backup.

Legacy bundle-only metadata remains readable by the restore path. This preserves the ability to undo an older installation even if cache-bootstrap migration has not completed.

### Restore Lifecycle

For expanded metadata, restoration validates before writing:

- the current bundle equals either its recorded patched or original hash;
- the current index equals either its recorded patched or original hash;
- both backups equal their recorded original hashes;
- the bootstrap file equals its recorded bootstrap hash if it exists.

It restores the exact original bundle and index through sibling temporary files and atomic renames. After both originals are in place, it removes only the patch-owned bootstrap file whose path and hash were validated. Backups and metadata remain available so repeated restore and later verified reinstallation are safe.

If any current target, backup, or bootstrap has unexpected bytes, restoration stops before modifying any target. Legacy metadata restores only the bundle using the existing validation behavior.

## Installation Data Flow

```text
npm run patch:codex-drop
  -> discover newest compatible Codex installation
  -> validate bundle transformation or existing v6 patch
  -> validate one index entry-module tag
  -> generate unique bootstrap module for captured entry URL
  -> stage backups, bootstrap, patched index, bundle, and metadata
  -> install verified files
  -> user reloads VS Code

first Codex webview load
  -> versioned bootstrap loads instead of Codex entry
  -> delete Cache Storage for current webview origin
  -> set session state to ready
  -> reload webview once

second Codex webview load
  -> bootstrap sees ready
  -> import original Codex entry
  -> freshly served app-initial bundle installs v6 drop handler
  -> Explorer drop inserts relative Markdown text without a card or Shift
```

## Failure Handling

- All source discovery, marker checks, source transformations, and existing-file hash validation complete before installed targets are replaced.
- Staged files use unique sibling temporary names and exclusive creation.
- A failed installation reports which phase failed and retains original backups.
- If a failure occurs after a target rename, the installer attempts to restore any target it changed from the already-validated backup before returning an error.
- Cache deletion failure does not create a reload loop or prevent Codex from opening; it falls back to loading the original entry and logs the runtime failure.
- The CLI reports that the first Codex load performs one automatic cache refresh and that the user must reload VS Code after installation or restoration.

## Testing

### Pure Transformation Tests

- extracts exactly one Codex entry-module URL from representative `index.html`;
- replaces only the entry tag and preserves preload and stylesheet tags;
- rejects missing, duplicate, or malformed entry tags and marker blocks;
- is idempotent for the supported bootstrap version;
- restores the exact original entry tag;
- generates a bootstrap containing the captured entry URL and versioned session key.

### Bootstrap Runtime Tests

- first load deletes every current-origin cache, stores `ready`, reloads once, and does not import Codex;
- ready state skips deletion and imports the original entry once;
- missing Cache Storage stores `failed`, does not reload, and imports Codex;
- rejected cache enumeration or deletion stores `failed`, logs once, does not reload, and imports Codex;
- failed state does not retry deletion and imports Codex.

### Installation Lifecycle Tests

- fresh installation creates and hashes bundle, index, and bootstrap artifacts;
- a second installation is idempotent;
- valid legacy v6 metadata migrates without changing the patched bundle or original bundle backup;
- expanded restore returns bundle and index to their exact original bytes and removes the verified bootstrap;
- legacy restore continues to restore a bundle-only installation;
- modified bundle, index, backup, bootstrap, stale metadata, and partial artifact combinations all fail closed;
- the CLI fixture includes a realistic index entry and reports patch, already-patched, migration, and restore states.

The final automated verification command is `npm run check`. Manual verification then requires reloading VS Code, opening Codex, allowing its one automatic webview refresh, and dropping both a file and a directory from Explorer without Shift. Expected composer text is workspace-relative Markdown, with a trailing slash for a directory, and no attachment card.

## Maintenance

A Codex update may change the bundle anchor, index entry tag, CSP structure, or service-worker behavior. The patcher must continue to fail closed rather than guessing. A bootstrap behavior change increments the bootstrap version and filename. A composer handler change increments `PATCH_VERSION`. A metadata shape change increments the metadata schema version while preserving explicit readers for supported older schemas.
