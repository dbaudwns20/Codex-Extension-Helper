# Codex Extension Helper

Codex Extension Helper is a personal VS Code Stable extension that shows qualifying external file writes directly in the normal editable editor. VS Code does not identify the process that changed a file, so the extension can show changes made by Codex and by other external writers that meet the same eligibility rules. Git operations that leave a file Git-clean are filtered out.

This is an independent, unofficial project. It is not affiliated with,
endorsed by, or sponsored by OpenAI.

## What appears in the editor

- Deleted content appears on dedicated translucent-red rows above the current changed lines, so removed and modified source is stacked vertically instead of overlapping.
- A deleted empty source line appears as an empty red row. The extension does not insert a `(blank line)` label.
- Added or replacement lines in the current document are highlighted in green and remain fully editable.
- VS Code Quick Diff gutter markers provide the native inline diff peek for complete deletion blocks.
- Each change has **Approve** and **Reject** CodeLens actions. The source already contains the external writer's latest text: Approve keeps that text and advances the comparison baseline without saving, while Reject edits the document back to the latest baseline and leaves that edit unsaved.
- The active editor's title bar shows previous/next change arrows plus **Approve All** and **Reject All** while that file has pending changes. Previous and next wrap from the first change to the last and from the last change to the first.
- Rejecting the single change in a newly created file—or choosing **Reject All**—moves the entire file to the operating system trash.
- Run **Codex Changes: Open Full Diff** from the Command Palette for a full comparison.
- Saving accepts the current document as the new baseline and immediately clears its comparison UI and title actions.
- A previously snapshotted background file keeps its pending comparison and renders it when opened.
- Git reset, restore, or checkout activity that leaves the file Git-clean clears or suppresses the review instead of presenting it as a Codex change.

VS Code Stable has no public editor-inset API. To create dedicated deleted rows, the extension temporarily inserts extension-owned blank lines into the live buffer and decorates those rows with the removed text. It removes those exact rows before save, Approve, Reject, disabling, or shutdown. The comparison model and review commands always use the canonical source without the temporary rows. Approve never saves; Reject applies an ordinary unsaved editor change so it can be reviewed before you save it.

## Review behavior

- **Approve** keeps the source already written by Codex or another external writer and accepts only the selected change in the in-memory comparison baseline.
- **Reject** restores the selected change from the latest baseline and leaves the restoration as an ordinary unsaved editor edit.
- **Approve All** keeps the complete current source without saving it.
- **Reject All** restores the complete baseline; for a newly created file, rejection moves the file to the operating system trash.
- Previous/next navigation and per-change actions use canonical source coordinates even while temporary deleted-line rows are visible.
- Before every save or review mutation, the extension removes its exact temporary rows so they are never intentionally written as accepted source.

## Requirements

- VS Code 1.105 or newer.

## Build, package, and install

From the repository root:

```bash
npm ci
npm run package
mv codex-extension-helper-0.0.1.vsix codex-extension-helper-0.0.1-stable.vsix
code --install-extension ./codex-extension-helper-0.0.1-stable.vsix --force
```

## Develop in VS Code Stable

Open this repository in VS Code Stable, create the fixture workspace once, and start the watcher:

```bash
mkdir -p test-fixtures/workspace
npm run watch
```

Then run the **Run Extension (Stable)** launch configuration. It opens `test-fixtures/workspace` with these effective arguments:

```bash
code --extensionDevelopmentPath="$PWD" \
  "$PWD/test-fixtures/workspace"
```

The default build task is **npm: watch**, which runs `npm run watch`. TypeScript continuously type-checks in no-emit mode while esbuild exclusively rebuilds the bundled `out/src/extension.js` runtime entry.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `codexExtensionHelper.enabled` | `true` | Enables detection and inline rendering. Turning it off clears active and pending comparison state. |
| `codexExtensionHelper.debounceMs` | `300` | Wait time in milliseconds before reading and comparing an external write (50–5000). |
| `codexExtensionHelper.maxFileSizeKb` | `1024` | Maximum eligible file size in KiB. |
| `codexExtensionHelper.exclude` | `**/.git/**`, `**/node_modules/**`, `**/dist/**`, `**/build/**` | Glob patterns excluded from tracking. |

Only `file` documents with decodable, non-binary content, a valid pre-change snapshot, an eligible size, and a non-excluded path are compared. A file must have a usable baseline before its external write; the extension does not invent a comparison for a file it has never observed.

## Data handling

- The extension reads qualifying workspace file content to compute comparisons locally inside the VS Code extension host.
- Comparison text and baselines are kept in memory only and are cleared when the extension host stops.
- The extension does not include telemetry, analytics, account integration, or code that intentionally sends workspace content over the network.
- Diagnostic messages remain in the local **Codex Extension Helper** output channel. They may include file paths or error details, but the extension does not intentionally log file content.
- Use `codexExtensionHelper.exclude` to exclude sensitive paths such as local secret or credential directories.

Review these behaviors before installing the extension in a workspace that
contains personal, confidential, or regulated information.

## License and limited sharing

The copyright holder may provide the packaged extension directly to designated
recipients for personal or internal use under the terms in the included
`LICENSE` file. Recipients may not redistribute it. Bundled third-party
software remains subject to the licenses and notices in the included
`THIRD_PARTY_NOTICES.txt` file.

## Limitations

- Comparison state is memory-only and does not persist across VS Code restarts.
- The extension cannot identify Codex as the writer. It suppresses Git operations that leave a file Git-clean, but other qualifying external writers can still appear as Codex-style review changes.
- Deleted content uses real temporary buffer rows because VS Code Stable does not expose `editorInsets`. These rows can briefly affect language services, formatters, dirty-state indicators, and autosave even though the extension removes them before writing the file.
- A hard extension-host crash can strand temporary blank rows in the unsaved buffer. Review the document before saving after a crash.
- `editor.codeLens` must remain enabled for per-change Approve/Reject actions to be visible.
- Diff editors, custom editors, binary or undecodable files, oversized files, excluded paths, and non-file documents do not render inline comparisons.

## Troubleshooting

Open **View → Output**, then choose **Codex Extension Helper** from the channel picker. File-read, eligibility, diff, and rendering failures are reported there. Deleted-row presentation intentionally makes temporary, reversible edits to eligible live documents.

If no UI appears, confirm that the setting is enabled and the file had an observed baseline before the external write. Review actions apply only to the active file. Use the gutter change marker for native Quick Diff or run **Codex Changes: Open Full Diff** from the Command Palette.
