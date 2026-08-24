# Changelog

All notable changes to this personal extension are documented in this file.

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

### Known limitations

- VS Code cannot identify the process responsible for a filesystem write, so all qualifying external writers are shown rather than Codex alone.
- Comparison state does not persist across restarts.
- Visual appearance across themes, folded regions, split editor groups, long lines, tabs, Unicode, and syntax-like text requires manual acceptance in the packaged extension.
