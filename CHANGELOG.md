# Changelog

All notable changes to this personal extension are documented in this file.

## 0.0.2 - 2026-08-26

### Added

- The packaged VSIX now includes the Codex Explorer drop patch manager and
  offers to apply the patch with explicit confirmation after installation or a
  compatible Codex update.
- Command Palette actions install or repair, remove, and report the status of
  the patch using the active `openai.chatgpt` extension directory.
- A macOS Explorer context-menu command directly inserts `@` mentions for one
  or more selected workspace files or folders without sending or depending on
  picker search results.

### Fixed

- Shift-dropped Explorer files and folders are inserted as Codex `@` mentions
  with Codex `26.820.60940` instead of absolute path text.
- Patch-state inspection verifies bundle, index, bootstrap, metadata, and
  recovery-backup hashes before reporting an installation as patched.
- Inline review display no longer inserts temporary deleted-line rows into the
  live buffer, keeping externally saved files clean and avoiding overwrite
  conflicts caused by presentation-only edits.
- The `Codex Changes` Source Control provider is now registered only while
  tracked changes exist, so it stays out of the Source Control view by default.
- Explorer drops insert Codex `atMention` nodes without creating a separate
  attachment card or relying on Codex's competing native drag handlers.
- Explorer context-menu insertion uses the same direct `atMention` path as
  drag-and-drop instead of searching the `@` picker.
- Codex bundle discovery accepts renamed minified event-registration functions,
  including the `26.820.60940` composer bundle.
- Verified v10 Codex bundle patches migrate safely to v11.

## 0.0.1 - 2026-08-24

### Added

- Automatic comparison of qualifying external file writes against an in-memory pre-change snapshot.
- CodeLens summaries for deleted or replaced original lines, with native Quick Diff and full-diff access.
- Green editor decorations for added or replacement lines in the current editable document.
- Deferred rendering for previously tracked background files, live realignment after user edits, and save-to-clear behavior.
- Eligibility controls for excluded paths, binary content, file size, URI scheme, and missing baselines.
- Per-hunk Approve and Reject actions. Approve keeps the already-modified source without saving; Reject restores the latest baseline as an unsaved editor change.
- Active-file-only title actions for wrapped previous/next navigation, Approve All, and Reject All.
- Trash-backed Reject All behavior for newly created files.
- VS Code Stable Extension Host coverage for Approve, Reject, all-file actions, save/delete cleanup, and created-file rejection.
- Personal VSIX packaging and a VS Code Stable development launch configuration.
- Translucent red decoration blocks for deleted content without modifying the live document buffer.
- Git-clean reset/restore suppression so Git cleanup does not appear as a new Codex review.

### Known limitations

- VS Code cannot identify the process responsible for a filesystem write, so all qualifying external writers are shown rather than Codex alone.
- Comparison state does not persist across restarts.
- Visual appearance across themes, folded regions, split editor groups, long lines, tabs, Unicode, and syntax-like text requires manual acceptance in the packaged extension.
- VS Code Stable decorations cannot reserve true editor rows, so dense or folded code may make deleted-content blocks less distinct.
