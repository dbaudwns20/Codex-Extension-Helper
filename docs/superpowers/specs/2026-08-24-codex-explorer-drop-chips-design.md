# Codex Explorer Drop Chips Design

## Goal

Allow files and folders dragged from the VS Code Explorer onto the Codex composer to become native Codex file-mention chips. Each dropped Explorer item produces exactly one chip: a file produces one file chip, and a directory produces one chip for the directory path without expanding its contents.

The implementation is a local, reversible patch to the installed Codex VS Code extension. This repository provides repeatable patch and restore commands because a Codex extension update installs a new bundle and removes the patch.

## Constraints

- A separate VS Code extension cannot access or modify another extension's isolated webview DOM through the public VS Code API.
- Inserting plain `@path` text does not guarantee that the Codex composer converts the text into a native mention chip.
- The patch must reuse Codex's existing file-descriptor-to-mention path so the resulting UI and submitted context match native file mentions.
- The generated patch targets the locally installed `openai.chatgpt-*` extension bundle and is intentionally version-sensitive.
- Existing repository changes are outside this feature's scope.

## Selected Approach

Patch the Codex composer bundle at the existing `addFileDescriptorsAsMentions` integration point. The injected handler receives Explorer drops in the capture phase, converts `text/uri-list` entries into the descriptor shape already consumed by Codex, and calls the captured native mention function.

This is preferred over simulating text input because it creates real chips deterministically. It is preferred over adding a new extension-host/webview protocol because it changes one bundle and reuses an existing composer-local capability.

## Components

### Patch Library

A focused module under `scripts/lib/` owns pure operations:

- parse an RFC-style `text/uri-list`, ignoring blank lines and comments;
- accept only `file:` URIs;
- convert file URIs into platform file paths;
- build `{ label, path, fsPath }` descriptors without reading or expanding directories;
- locate the unique Codex composer anchor;
- insert or remove the marked patch exactly once;
- compute hashes and validate patch metadata.

The URI and source-transformation functions remain independent of filesystem discovery so they can be unit tested without an installed Codex extension.

### Patch Command

`scripts/patch-codex-drop.mjs`:

1. Finds installed `openai.chatgpt-*` extension directories in the VS Code and VS Code Insiders extension roots.
2. Selects the newest compatible installation unless an explicit extension directory is supplied.
3. Finds the single `app-initial-*.js` bundle containing the validated composer anchor.
4. Refuses to continue if the anchor is absent, duplicated, or already altered unexpectedly.
5. Writes an adjacent original backup and metadata containing the extension version, target path, original hash, patched hash, and patch version.
6. Applies the marked injection atomically.
7. Verifies the marker, expected replacement count, and resulting hash before reporting success.

Repeated execution against an already patched and verified bundle succeeds without applying a second patch.

### Restore Command

`scripts/unpatch-codex-drop.mjs` reads the metadata adjacent to the target bundle. It restores only when the current bundle hash equals the recorded patched hash and the backup hash equals the recorded original hash. A mismatch stops without overwriting either file.

### Injected Drop Handler

The injected code attaches once to the active composer DOM node and uses a stable marker to prevent duplicate listeners. It listens for `dragover` and `drop` in the capture phase.

For a supported drop it:

1. Reads `text/uri-list` from `DataTransfer`.
2. Parses every non-comment `file:` URI.
3. Converts each URI to an absolute filesystem path.
4. Creates one descriptor per URI with the basename as `label` and the absolute path as both `path` and `fsPath`.
5. Calls the composer-scoped native `addFileDescriptorsAsMentions` function once with the descriptor list.
6. Focuses the composer and prevents the browser editor from inserting raw URI text.

Unsupported or empty drops are left untouched so existing Codex behavior continues normally. Directories are not traversed or statted; their URI becomes one descriptor just like an individual file URI.

## Data Flow

```text
VS Code Explorer drag
  -> webview DataTransfer (`text/uri-list`)
  -> capture-phase Codex composer drop handler
  -> file URI parser
  -> one descriptor per dropped item
  -> Codex addFileDescriptorsAsMentions
  -> native mention chip(s)
```

## Failure Handling and Safety

- Source discovery and all validation complete before a write occurs.
- An unknown Codex bundle layout, missing anchor, multiple anchors, unsupported URI, or metadata mismatch produces a clear nonzero exit without modifying the installation.
- The original bundle is backed up before replacement.
- Writes use a temporary sibling followed by an atomic rename.
- The patch contains a versioned start/end marker for detection and diagnostics.
- The patcher never recursively edits extension directories and never deletes backups.
- Restore refuses to overwrite a bundle changed after patching.
- Applying the patch requires VS Code to reload so the modified webview asset is served.

## Commands

The repository exposes:

- `npm run patch:codex-drop` to patch the newest compatible installed Codex extension;
- `npm run unpatch:codex-drop` to restore the recorded original bundle;
- optional direct script arguments to target a specific Codex extension directory for tests or multiple installations.

## Testing

Unit tests cover:

- one file URI;
- one directory URI remaining one descriptor;
- multiple dropped items producing the same number of descriptors;
- spaces, percent encoding, Unicode, and CRLF input;
- comments, blank lines, and non-file URIs;
- exact single-anchor replacement;
- missing and duplicate anchor rejection;
- idempotent patch detection;
- metadata and hash validation;
- restore refusal after external modification.

An integration-style fixture test creates a temporary fake Codex installation with a minimal bundle containing the real anchor shape. It runs patch, verifies the injected marker and unchanged surrounding source, runs patch again to prove idempotence, and restores the exact original bytes.

After automated tests pass, the patch command is run against the current local Codex installation. Verification consists of reloading VS Code and manually dropping a file, a directory, and multiple mixed Explorer selections into the composer. The expected result is one native mention chip per dropped Explorer item and no raw `file:` URI text.

## Maintenance

Codex updates may change minified identifiers or the composer structure. The patcher intentionally fails closed when the validated anchor changes. Supporting a new Codex version requires inspecting the new bundle, updating the anchor and injection template, incrementing the patch version, and adding a fixture for the new shape. The patcher must never guess at a near match.
