# Codex Extension Helper

Codex Extension Helper is a private, unofficial VS Code extension for reviewing
external file writes directly in the normal editable editor. It compares a
qualifying disk change with the last in-memory snapshot, highlights additions
and deletions, and lets you approve or reject changes by hunk, file, or across
the current workspace.

The extension also includes optional tools for inserting Explorer files and
folders as Codex `@` mentions. It is not affiliated with, endorsed by, or
sponsored by OpenAI.

## Features

### Inline review

- Added and replacement lines remain editable and are highlighted in green.
- Deleted lines appear in translucent red at their former location without
  becoming part of the document text.
- Empty deleted lines remain visually empty; no placeholder text is inserted.
- Each change exposes **Approve** and **Reject** CodeLens actions.
- The editor title provides previous/next navigation plus **Approve All** and
  **Reject All** while the active file has pending changes.
- Quick Diff gutter markers open VS Code's native comparison view, and
  **Codex Changes: Open Full Diff** opens the complete file diff.
- Saving accepts the current document as the new baseline and clears its review
  state.

VS Code Stable does not expose an editor-inset API. Deleted content is rendered
with decorations, so the review UI does not add persistent text to the file or
make the document dirty. Review actions operate on the canonical file content.

### Source Control review

The `Codex Changes` Source Control provider appears only while pending changes
exist and lists every affected file.

- Clicking a file opens its full diff.
- File-row **Approve File** and **Reject File** actions process that file.
- Provider-title **Approve All Files** and **Reject All Files** actions process
  every file currently listed.
- A background file can be approved or rejected without first making it the
  active editor.

### Codex Explorer `@` mentions

On macOS, select one or more workspace files or folders in Explorer and choose
**Codex: Add as @ Mention**. The command opens the Codex sidebar, copies a
private payload, and pastes it into the composer. Each resource becomes one
inline `@` mention without sending the message or creating a separate
attachment card. Directories are not expanded.

This command requires the Codex Explorer drop patch described below. macOS may
also require Accessibility permission for Visual Studio Code under **System
Settings → Privacy & Security → Accessibility**.

## Review behavior

The source on disk already contains the external writer's latest text when a
review begins.

| Action | Result |
| --- | --- |
| **Approve** | Keeps the selected change and advances that part of the in-memory baseline without saving. |
| **Reject** | Restores the selected baseline content as an ordinary unsaved editor edit. |
| **Approve All** | Keeps every change in the selected file without saving. |
| **Reject All** | Restores the complete file baseline as an unsaved edit. |
| **Approve All Files** | Accepts all files currently listed in `Codex Changes`. |
| **Reject All Files** | Restores all files currently listed in `Codex Changes`. |

Rejecting all changes in a newly created file moves that file to the operating
system trash. Navigation wraps between the first and last change.

VS Code does not identify which process wrote a file. The extension therefore
shows every qualifying external write, not only writes made by Codex. Git
operations that leave a resource Git-clean are cleared or suppressed rather
than shown as review changes.

## Requirements

- VS Code 1.101.1 or newer.
- Node.js and npm for building from source.
- macOS for automatic Explorer-to-Codex `@` mention insertion.
- The OpenAI Codex VS Code extension for Codex mention and patch features.

## Build, package, and install

From the repository root:

```bash
npm ci
npm run package
code --install-extension ./codex-extension-helper-0.0.3.vsix --force
```

`npm run package` compiles the extension, runs the unit test suite, and creates
the VSIX. The package contains the bundled runtime, manifest, README, changelog,
license, and third-party notices.

## Codex Explorer drop patch

The patch manager and patch implementation are included in the VSIX. On normal
startup, the extension inspects the installed `openai.chatgpt` extension. When
a compatible installation needs the patch or a verified older patch needs an
update, a modal prompt offers **Apply and Reload**. Dismissing the prompt leaves
the Codex installation unchanged.

The patch is applied transactionally. It records metadata and preserves
recovery backups; inspection verifies the bundle, index, bootstrap, metadata,
and backup hashes before reporting the installation as patched. An unknown or
invalid bundle layout fails closed without modifying the Codex installation.

The Command Palette exposes:

- **Codex Helper: Install/Repair Drop Patch**
- **Codex Helper: Remove Drop Patch**
- **Codex Helper: Show Drop Patch Status**

Removing the patch verifies the recorded backups before offering **Remove and
Reload**. After Codex updates, the new installation is inspected on the next
VS Code start.

Repository scripts provide the same workflow for development:

```bash
npm run patch:codex-drop
# Reload VS Code after the patch is applied.

npm run unpatch:codex-drop
# Reload VS Code after the original files are restored.
```

Automatic CLI mode selects the numerically newest installed
`openai.chatgpt-*` directory and fails closed when that installation is not
supported; it does not silently fall back to an older version. To target an
older side-by-side installation intentionally, pass its directory explicitly:

```bash
node scripts/patch-codex-drop.mjs --extension-dir <extension-path>
node scripts/unpatch-codex-drop.mjs --extension-dir <extension-path>
```

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `codexExtensionHelper.enabled` | `true` | Enables external-change detection and review UI. Disabling it clears pending in-memory state. |
| `codexExtensionHelper.debounceMs` | `300` | Delay before comparing an external write, from 50 to 5000 ms. |
| `codexExtensionHelper.maxFileSizeKb` | `1024` | Maximum eligible file size in KiB. |
| `codexExtensionHelper.exclude` | `**/.git/**`, `**/node_modules/**`, `**/dist/**`, `**/build/**` | Glob patterns excluded from tracking. |

Only `file` resources with decodable, non-binary text, an eligible size, and a
non-excluded workspace path are compared. Existing files need an observed
in-memory baseline before an external write can be reviewed; newly detected file
creation is compared with an empty baseline.

## Development

Create the extension-host fixture workspace once and start the watcher:

```bash
mkdir -p test-fixtures/workspace
npm run watch
```

Then run the **Run Extension (Stable)** launch configuration. The watcher runs
TypeScript checking in no-emit mode while esbuild rebuilds the bundled
`out/src/extension.js` runtime.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run compile` | Type-check and build the bundled extension runtime. |
| `npm run watch` | Watch TypeScript and runtime sources during development. |
| `npm run test:unit` | Run the unit test suite once. |
| `npm run test:extension` | Compile and run the VS Code extension-host tests. |
| `npm run check` | Compile and run all unit tests. |
| `npm run package` | Run checks and create the distributable VSIX. |

## Data handling

- Eligible workspace files are read locally in the VS Code extension host to
  compute comparisons.
- Baselines and comparison text remain in memory and are cleared when the
  extension host stops.
- The project contains no telemetry, analytics, or account integration and does
  not intentionally send workspace content over the network.
- Diagnostic output remains in the local **Codex Extension Helper** output
  channel. Messages may contain paths or error details but do not intentionally
  include file content.
- Sensitive directories can be excluded with `codexExtensionHelper.exclude`.

Review these behaviors before using the extension with personal, confidential,
or regulated data.

## Limitations

- Review state does not persist across VS Code restarts.
- The writer cannot be attributed to Codex; other qualifying external writers
  can appear in the same review UI.
- Deleted decorations cannot reserve true editor rows and may be less distinct
  in dense or folded code.
- `editor.codeLens` must remain enabled for per-change Approve/Reject actions.
- Diff editors, custom editors, binary or undecodable content, oversized files,
  excluded paths, and non-file resources do not render inline comparisons.
- Codex patch compatibility depends on the installed Codex bundle layout. An
  unsupported layout is reported and left unchanged.

## Troubleshooting

Open **View → Output** and select **Codex Extension Helper** to inspect file-read,
eligibility, diff, rendering, Codex insertion, and patch errors.

If no review UI appears:

1. Confirm `codexExtensionHelper.enabled` is enabled.
2. Confirm the path is not excluded and the file is below the size limit.
3. For an existing file, open it before the external write so an in-memory
   baseline exists.
4. Confirm `editor.codeLens` is enabled if only hunk actions are missing.
5. Use a gutter marker or **Codex Changes: Open Full Diff** when inline deleted
   decorations are hard to distinguish.

If Explorer `@` mention insertion fails, confirm the Codex patch status from the
Command Palette and allow Visual Studio Code under macOS Accessibility settings.

## License and sharing

The copyright holder may provide the packaged extension directly to designated
recipients for personal or internal use under the terms in `LICENSE`.
Recipients may not redistribute it. Bundled third-party software remains
subject to the licenses and notices in `THIRD_PARTY_NOTICES.txt`.
