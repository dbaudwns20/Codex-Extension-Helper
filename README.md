# Codex Inline Changes

Codex Inline Changes is a personal VS Code Insiders extension that shows qualifying external file writes directly in the normal editable editor. Despite the name, VS Code does not identify the process that changed a file, so the extension shows changes made by Codex **and by every other external writer** that meets the same eligibility rules.

## What appears in the editor

- Deleted or replaced original lines appear in red, read-only blocks at their former location.
- Added or replacement lines in the current document are highlighted in green and remain fully editable.
- A replacement places the red original block immediately before the green current lines.
- Saving accepts the current document as the new baseline and immediately clears both kinds of comparison UI.
- A previously snapshotted background file keeps its pending comparison and renders it when opened.

The red blocks are visual history only. They are never inserted into the document, and the extension never edits, reverts, or saves a file for you.

## Requirements

- VS Code Insiders is required. Stable VS Code is not supported.
- The extension uses the proposed `editorInsets` API and must be launched with proposed API access enabled for the full extension identifier `local.codex-inline-changes`.
- Marketplace publication is not supported because proposed APIs are unstable and restricted. The generated VSIX is for personal installation.

## Build, package, and install

From the repository root:

```bash
npm ci
npm run package
code-insiders --install-extension ./codex-inline-changes-0.0.1.vsix --force
```

Launch the installed extension against a workspace with the proposal enabled:

```bash
code-insiders --enable-proposed-api=local.codex-inline-changes /absolute/path/to/workspace
```

The proposed API flag is required each time the relevant Insiders process starts unless you have configured the equivalent Insiders runtime setting yourself. If the `code-insiders` shell command is unavailable on macOS, install it from VS Code Insiders with **Shell Command: Install 'code-insiders' command in PATH**.

## Develop in VS Code Insiders

Open this repository in VS Code Insiders, create the fixture workspace once, and start the watcher:

```bash
mkdir -p test-fixtures/workspace
npm run watch
```

Then run the **Run Extension (Insiders)** launch configuration. It opens `test-fixtures/workspace` with these effective arguments:

```bash
code-insiders --extensionDevelopmentPath="$PWD" \
  --enable-proposed-api=local.codex-inline-changes \
  "$PWD/test-fixtures/workspace"
```

The default build task is **npm: watch**, which runs `npm run watch`. TypeScript continuously type-checks in no-emit mode while esbuild exclusively rebuilds the bundled `out/src/extension.js` runtime entry.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `codexInlineChanges.enabled` | `true` | Enables detection and inline rendering. Turning it off clears active and pending comparison state. |
| `codexInlineChanges.debounceMs` | `300` | Wait time in milliseconds before reading and comparing an external write. |
| `codexInlineChanges.maxFileSizeKb` | `1024` | Maximum eligible file size in KiB. |
| `codexInlineChanges.exclude` | `**/.git/**`, `**/node_modules/**`, `**/dist/**`, `**/build/**` | Glob patterns excluded from tracking. |

Only `file` documents with decodable, non-binary content, a valid pre-change snapshot, an eligible size, and a non-excluded path are compared. A file must have a usable baseline before its external write; the extension does not invent a comparison for a file it has never observed.

## Limitations

- There are no Accept or Reject controls. The current document already contains the external writer's latest content; saving simply clears the visual comparison and establishes the next baseline.
- Comparison state is memory-only and does not persist across VS Code restarts.
- The extension cannot distinguish Codex from formatters, scripts, generators, Git operations, or other external writers.
- Stable VS Code and Marketplace distribution are not supported.
- Diff editors, custom editors, binary or undecodable files, oversized files, excluded paths, and non-file documents do not render inline comparisons.

## Troubleshooting

Open **View → Output**, then choose **Codex Inline Changes** from the channel picker. File-read, eligibility, diff, and rendering failures are reported there and never cause the extension to modify the affected document.

If no UI appears, confirm that you are running VS Code Insiders, the process was started with `--enable-proposed-api=local.codex-inline-changes`, the setting is enabled, and the file had an observed baseline before the external write. Without proposed API support, the extension shows one actionable warning and disables rendering without changing files.
