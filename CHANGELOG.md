# Changelog

All notable changes to this personal extension are documented in this file.

## 0.0.1 - 2026-08-21

### Added

- Automatic comparison of qualifying external file writes against an in-memory pre-change snapshot.
- Read-only red inline blocks for deleted or replaced original lines.
- Green editor decorations for added or replacement lines in the current editable document.
- Deferred rendering for previously tracked background files, live realignment after user edits, and save-to-clear behavior.
- Eligibility controls for excluded paths, binary content, file size, URI scheme, and missing baselines.
- VS Code Insiders Extension Host coverage for external write, renderer-resource creation, and save cleanup.
- Personal VSIX packaging and an Insiders development launch configuration with proposed API access.

### Known limitations

- VS Code cannot identify the process responsible for a filesystem write, so all qualifying external writers are shown rather than Codex alone.
- There are no Accept or Reject controls, and comparison state does not persist across restarts.
- VS Code stable and Marketplace publication are unsupported because the extension depends on the proposed `editorInsets` API.
- Visual appearance across themes, folded regions, split editor groups, long lines, tabs, Unicode, and syntax-like text requires manual acceptance in the packaged extension.
