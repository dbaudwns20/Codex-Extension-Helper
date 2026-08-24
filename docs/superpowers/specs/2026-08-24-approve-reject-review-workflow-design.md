# Approve/Reject Review Workflow Design

## Purpose

Add a Cursor-style review workflow to Codex Extension Helper. Codex or another external process has already written its changes into the real workspace file. Review actions decide whether those existing changes remain in the file or are reverted to the pre-change baseline.

## User Semantics

- **Approve** keeps the selected hunk exactly as it currently exists in the document and removes that hunk from the comparison UI.
- **Reject** restores the selected hunk to its pre-external-change content.
- **Approve All** keeps every current change in the active file and clears that file's comparison UI.
- **Reject All** restores an existing active file to its current review baseline. Before any partial approvals this is the full pre-change content; already approved hunks remain accepted.
- **Reject** or **Reject All** for an externally created file deletes that file using the VS Code filesystem API with trash enabled.
- Approve operations never save the document. The user retains control of persistence through the normal VS Code save workflow.
- All-file actions apply only to the active file, never to every pending file in the workspace.

## Review UI

Every current hunk receives CodeLens actions on a dedicated row above its first modified line:

- a compact deleted-content summary when original lines exist;
- **Approve**;
- **Reject**.

Single-line deleted content is shown directly. Multiline deleted content is summarized as `N deleted lines`; the command tooltip contains the full deleted block. Addition-only hunks still receive Approve and Reject actions.

The active editor title contains four buttons while that file has pending hunks:

1. Previous Change
2. Next Change
3. Approve All
4. Reject All

Previous and Next reveal the target hunk in the center of the editor and move the primary selection to its anchor. Navigation wraps at the first and last hunk. Buttons are contributed through stable `editor/title` menu commands and are gated by an active-file context key.

## Comparison State

`FileComparisonState` gains an explicit `createdFile` flag. Normal seeded or saved files set it to `false`; `externalCreate` sets it to `true`. The state continues to carry:

- `baselineText`: the currently unreviewed pre-change side;
- `currentText`: the live document text used for the latest comparison;
- current hunks;
- source revision and lifecycle flags.

Every rendered hunk is addressed by file key, source revision, and hunk index. Commands must resolve this reference against the latest state before acting. A mismatched revision, index, or live document text is stale and must not edit the document.

## Approving Changes

### Approve One Hunk

Approving a hunk does not edit the document. Instead, the coordinator applies the hunk's modified side to `baselineText`, producing a partially accepted baseline. It then diffs that baseline against the unchanged current document. The approved hunk disappears while remaining hunks retain their review UI.

Line replacement is defined from the hunk's zero-based, end-exclusive original coordinates. The approved baseline replaces `originalStart..originalEnd` with `modifiedLines`. Line-ending and final-newline behavior must be preserved by a dedicated text patch helper rather than by joining all lines with a hard-coded newline.

If no hunks remain, the current document becomes the accepted in-memory baseline, `comparisonActive` becomes false, and all decorations, CodeLens entries, Quick Diff state, and title buttons for the file are cleared. No save command is invoked.

### Approve All

Approve All uses the current live document text as the new in-memory baseline and clears the comparison through the same accepted-state lifecycle. It does not call `TextDocument.save` or write through `workspace.fs`.

## Rejecting Changes

### Reject One Hunk

For an existing file, Reject builds a guarded `WorkspaceEdit` against the hunk's modified coordinates:

- addition: delete the current added range;
- deletion: insert the original lines at the deletion anchor;
- modification: replace the current modified range with the original lines.

The edit uses the live document's EOL style and preserves final-newline semantics. After VS Code applies the edit, the normal document-change path recomputes remaining hunks against the current partially accepted baseline.

An externally created file is represented as an addition from an empty baseline. Rejecting its hunk deletes the file through `workspace.fs.delete(uri, { useTrash: true })` instead of leaving an empty file.

### Reject All

For an existing file, Reject All replaces the entire live document with the latest `baselineText` using `WorkspaceEdit`. This rejects every remaining hunk without undoing hunks that were already approved into that baseline. For an externally created file, it deletes the file with trash enabled. Successful rejection clears the comparison lifecycle; failed rejection leaves state and UI intact.

## Commands and Runtime Boundaries

A focused review controller owns command registration and delegates pure state transitions to the coordinator. It exposes:

- `approveHunk(reference)`
- `rejectHunk(reference)`
- `approveAll(uri?)`
- `rejectAll(uri?)`
- `previousChange(uri?)`
- `nextChange(uri?)`

The coordinator owns baseline transitions and stale revision validation. The runtime owns VS Code operations such as resolving the active editor, applying `WorkspaceEdit`, deleting files, revealing ranges, updating selections, and showing messages.

The CodeLens provider receives full current hunk descriptors and produces the deleted summary plus per-hunk action commands. The existing renderer remains responsible only for green current-line decorations. Quick Diff always uses the coordinator's latest partially accepted baseline.

## Context and Visibility

The extension maintains a context key such as `codexExtensionHelper.activeFileHasChanges`. It is updated when:

- the active editor changes;
- visible editors change;
- a comparison is created or recomputed;
- a hunk is approved or rejected;
- all changes are accepted, rejected, saved, deleted, or invalidated;
- the extension is disabled or disposed.

Editor-title commands use this key together with `resourceScheme == file`. Command handlers still validate active state; context keys control presentation, not correctness.

## Concurrency and Failure Handling

- Every hunk action verifies the source revision and exact current document text before applying state or file changes.
- A stale action triggers a refresh and performs no edit.
- A newer external write, user edit, save, file delete, or workspace removal invalidates older action references.
- Approve state transitions update the revision before asynchronous rendering.
- Reject edits use the document version observed during validation. If the edit cannot be applied, comparison state remains unchanged.
- Filesystem deletion failures and edit failures are logged to the Codex Extension Helper output channel and shown as concise error messages.
- Rejecting a created file uses trash instead of permanent deletion whenever the provider supports it.

## Testing Strategy

Unit tests cover:

- patching a baseline for addition, deletion, and modification hunks;
- EOL and final-newline preservation;
- approving one hunk while retaining others;
- Approve All clearing state without invoking save or filesystem writes;
- rejecting each hunk kind with correct edit ranges and replacement text;
- Reject All restoring existing content;
- Reject and Reject All deleting created files with trash enabled;
- stale revision, stale hunk index, and live-text mismatch rejection;
- CodeLens commands for addition-only and deleted-content hunks;
- active-file context changes;
- previous and next navigation, including wraparound.

Extension-host coverage verifies command registration, editor-title visibility conditions, a representative Approve flow, a representative Reject flow, and cleanup after save or file deletion.

## Stable API Constraints

The implementation uses only stable VS Code APIs:

- `languages.registerCodeLensProvider`;
- `commands.registerCommand` and `commands.executeCommand('setContext', ...)`;
- `contributes.menus.editor/title`;
- `WorkspaceEdit` and `workspace.applyEdit`;
- `workspace.fs.delete` with trash enabled;
- `TextEditor.revealRange` and selections;
- existing decorations, Quick Diff, and virtual baseline documents.

No proposed editor inset API, undocumented command, automatic save, or direct filesystem mutation outside the VS Code API is introduced.

## Non-Goals

- Workspace-wide Approve All or Reject All.
- Persistent review state across extension-host restarts.
- Automatic saving after approval or rejection.
- Identifying Codex as the exact external writer.
- Reproducing Cursor's private editor inset implementation pixel-for-pixel.
