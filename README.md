# Codex Extension Helper

Codex Extension Helper is a personal VS Code Stable extension that shows qualifying external file writes directly in the normal editable editor. VS Code does not identify the process that changed a file, so the extension shows changes made by Codex **and by every other external writer** that meets the same eligibility rules.

## What appears in the editor

- Deleted content appears in a dedicated CodeLens row above the current changed line.
- A single deletion shows its original text; multiple deletions show a compact `N deleted lines` summary.
- Added or replacement lines in the current document are highlighted in green and remain fully editable.
- VS Code Quick Diff gutter markers provide the native inline diff peek for complete deletion blocks.
- Run **Codex Changes: Open Full Diff** from the Command Palette for a full comparison.
- Saving accepts the current document as the new baseline and immediately clears both kinds of comparison UI.
- A previously snapshotted background file keeps its pending comparison and renders it when opened.

The deletion rows are visual history only. They are never inserted into the document, and the extension never edits, reverts, or saves a file for you.

## Requirements

- VS Code 1.105 or newer.
- No proposed API flag or Insiders build is required.

## Build, package, and install

From the repository root:

```bash
npm ci
npm run package
code --install-extension ./codex-extension-helper-0.0.1.vsix --force
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

## Limitations

- There are no Accept or Reject controls. The current document already contains the external writer's latest content; saving simply clears the visual comparison and establishes the next baseline.
- Comparison state is memory-only and does not persist across VS Code restarts.
- The extension cannot distinguish Codex from formatters, scripts, generators, Git operations, or other external writers.
- Stable VS Code cannot render custom red editor insets, so deletion rows use the editor's CodeLens styling and open native diff when clicked.
- `editor.codeLens` must remain enabled for deletion rows to be visible.
- Diff editors, custom editors, binary or undecodable files, oversized files, excluded paths, and non-file documents do not render inline comparisons.

## Troubleshooting

Open **View → Output**, then choose **Codex Extension Helper** from the channel picker. File-read, eligibility, diff, and rendering failures are reported there and never cause the extension to modify the affected document.

If no UI appears, confirm that the setting is enabled and the file had an observed baseline before the external write. Use the gutter change marker for native Quick Diff or run **Codex Changes: Open Full Diff** from the Command Palette.
