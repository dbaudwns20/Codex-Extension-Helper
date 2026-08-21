# Codex Inline Changes VS Code Extension Design

## Purpose

Build a personal VS Code Insiders extension that automatically shows changes made by external processes, including Codex, inside the normal editable text editor. The extension must not require the user to click a Review button or open a diff editor.

The extension is intentionally tool-agnostic because the VS Code API does not identify which external process changed a file. Any qualifying external filesystem modification is treated as an agent change.

## User Experience

1. The extension snapshots the content of opened workspace files.
2. An external process changes one or more tracked files.
3. The extension detects the filesystem event, reads the new content, and computes line-oriented change hunks against the snapshot.
4. For every visible changed file:
   - deleted original lines appear as a red, read-only multiline inset at their former location;
   - added or modified current lines receive a green editor decoration;
   - a replacement shows the red original block immediately before the green current block.
5. Changes in non-visible tracked files are stored and rendered when those files become visible.
6. If the user edits a file while its comparison is visible, the diff is recalculated against the original pre-external-change snapshot so positions stay aligned.
7. Saving the file clears all comparison UI for that file and makes the saved content its new snapshot.

There are no Accept or Reject controls. The actual document already contains the external process's latest content; the red blocks are visual-only references and never become part of the file.

## Platform and Distribution Constraints

- Target VS Code Insiders rather than stable VS Code.
- Use the proposed `editorInsets` API through `window.createWebviewTextEditorInset`.
- Declare `enabledApiProposals: ["editorInsets"]` in the extension manifest.
- Run VS Code Insiders with proposed API access enabled for the extension identifier.
- Package the result as a personal VSIX. Marketplace publication is out of scope because proposed APIs are unstable and restricted.
- If the proposed API is unavailable, show one actionable warning and disable rendering without changing files.

## Architecture

### SnapshotStore

Maintains per-file state keyed by normalized file URI:

- accepted snapshot text and end-of-line style;
- current comparison hunks;
- latest document version;
- active editor decorations and inset handles;
- whether a comparison is pending for a non-visible file.

State is memory-only. Closing a document may release rendering objects, but a pending comparison remains available while the extension is active so it can render when the file is reopened. Saving, deleting, or moving a file clears its state.

### ExternalChangeDetector

Uses `workspace.createFileSystemWatcher` for workspace files. It records recent `onDidSaveTextDocument` events and suppresses corresponding watcher events so normal editor saves do not start a comparison.

Events are debounced per URI. The default debounce is 300 ms so atomic writes and bursts of Codex edits become one comparison. Create and delete events clean up or initialize state as appropriate.

The detector only starts a new comparison when a usable pre-change snapshot exists. For a file that was never opened or cached before the external write, it records the current content as the initial snapshot instead of displaying an invalid diff.

### DiffEngine

Computes deterministic line-based hunks containing:

- original start and end line;
- modified start and end line;
- original lines;
- modified lines;
- kind: addition, deletion, or modification.

Line endings are normalized for comparison but preserved in snapshots. Empty files, edits at the first or last line, and a missing trailing newline are explicit test cases.

The initial implementation uses a small isolated diff dependency or algorithm behind a `DiffEngine` interface. This prevents rendering and tracking code from depending on a specific diff package.

### InlineRenderer

Uses two mechanisms in the normal editable editor:

- proposed editor insets render multiline deleted/original blocks with escaped HTML inside a restricted Webview;
- standard text editor decorations highlight added and modified current lines.

Insets contain no scripts and use a strict content security policy. HTML is escaped before rendering. Styling uses VS Code theme variables and diff-related colors where available, with readable fallbacks for light and dark themes.

For pure deletions, the inset is placed before the next surviving line. A deletion at end of file is placed after the final line. Insets are disposed and recreated when hunks move because of user edits. Decorations use closed range behavior so unrelated typing does not expand them unexpectedly.

### ComparisonCoordinator

Coordinates detector, snapshot, diff, and renderer events. It serializes updates per URI so out-of-order filesystem reads cannot render stale results. Before applying a result, it verifies that the document version and expected file content still match the computation input.

## Configuration

```jsonc
{
  "codexInlineChanges.enabled": true,
  "codexInlineChanges.debounceMs": 300,
  "codexInlineChanges.maxFileSizeKb": 1024,
  "codexInlineChanges.exclude": [
    "**/.git/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**"
  ]
}
```

Configuration changes take effect without restarting when practical. Disabling the extension immediately disposes all visible decorations, insets, watchers, and pending comparison state.

## Eligibility and Safety

The extension skips:

- non-`file` documents;
- binary or undecodable content;
- files larger than the configured limit;
- excluded paths;
- files without a valid pre-change snapshot;
- diff and custom editors that cannot host text-editor insets.

Rendering is read-only. No automatic document edit, revert, save, or Git operation is performed. Failure to read, diff, or render a file is logged to a dedicated output channel and must not alter the document.

## Event and Race Handling

- Filesystem events are debounced per URI.
- User save wins over a simultaneous external-change event: comparison UI is cleared and the saved text becomes the snapshot.
- A newer filesystem or document version invalidates an in-flight diff result.
- Editor close disposes view-specific UI but does not discard a pending comparison.
- Editor reopen or visibility change re-renders the current stored comparison.
- User edits during an active comparison trigger a debounced recomputation from the original snapshot to current document text.
- File deletion, rename, workspace-folder removal, and extension deactivation dispose all related resources.

## Testing Strategy

### Unit Tests

- addition, deletion, and replacement hunks;
- changes at file start and end;
- empty files and missing trailing newline;
- CRLF and LF normalization;
- debounce and stale-result cancellation;
- recent-save suppression;
- multiple independent file states;
- exclusion and file-size rules;
- save-to-clear lifecycle.

### Extension Host Tests

- proposed inset creation and disposal in VS Code Insiders;
- green decorations on current changed lines;
- automatic rendering after an external file write;
- deferred rendering when a changed file becomes visible;
- recomputation after user edits;
- clearing on save;
- cleanup after editor close and extension deactivation.

### Manual Verification

- light and dark themes;
- long lines, tabs, Unicode, and syntax-like HTML characters;
- folded regions and multiple editor groups;
- rapid multi-file Codex edits;
- proposed API unavailable startup path;
- installation and launch from the packaged personal VSIX.

## Deliverables

- extension source project;
- type declarations needed for the proposed API;
- automated unit and Extension Host tests;
- README with limitations and VS Code Insiders launch instructions;
- personal-use VSIX package.

## Explicit Non-Goals

- identifying Codex as the exact modifying process;
- Accept or Reject buttons;
- changing or reverting file content;
- stable VS Code or Marketplace support;
- a custom editor or separate diff editor;
- persistent comparison state across VS Code restarts.
