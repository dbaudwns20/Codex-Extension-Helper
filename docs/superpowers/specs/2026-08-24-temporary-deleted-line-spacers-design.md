# Temporary Deleted-Line Spacers Design

## Goal

Render deleted source lines above modified source lines in VS Code Stable without `editorInsets` and without overlaying existing editor rows. The extension will temporarily insert real blank lines into the live document, render deleted text on those blank lines, and remove every extension-owned blank line before saving or running a review mutation.

The source written by Codex remains the canonical current text. Temporary display lines are presentation state only and must never become part of the accepted or rejected source.

## Constraints

- VS Code Stable does not expose an API for editor view zones or insets.
- Approve keeps the canonical current source. Reject restores the baseline source.
- Saving accepts the canonical current source and clears the review.
- Existing Git-clean change suppression remains in place.
- Existing CodeLens review actions and editor-title actions remain in place.
- The user requested no automated test execution. Verification is limited to TypeScript compilation, package creation, archive integrity, and source-level consistency checks.
- User-authored text must never be removed merely because it resembles a spacer.

## Selected Approach

Add a `TemporaryLineSpacerManager` between comparison state and editor presentation. It owns the exact mapping between canonical text and display text for each reviewed document.

For every hunk with deleted original lines, the manager inserts one EOL sequence per deleted line at the hunk's canonical modified-line anchor. Each resulting blank display row is decorated as a whole line with the removed-text background, and the corresponding original line is rendered as attachment text on that otherwise blank row.

The manager never asks the diff engine or coordinator to compare display text. Comparison state, hunk references, expected text, Approve, and Reject continue to use canonical text only.

## Data Model

Each installed presentation has immutable state:

- document key and URI;
- canonical text and canonical document version before installation;
- exact display text and document version after installation;
- document EOL sequence;
- spacer spans in display offsets;
- per-hunk canonical-to-display line mapping;
- a monotonically increasing presentation revision.

A spacer span records only EOL text inserted by the extension. Removal is allowed only when the live document text and version match the installed presentation, or when an unexpected edit can be proven not to intersect a spacer and the spans can be deterministically rebased.

## Placeholder Planning

A pure planner receives canonical text, EOL, and hunks and returns:

- ordered insertion edits;
- exact display text;
- deletion edits that restore canonical text;
- mapped display anchors for removed rows, modified rows, CodeLens actions, and navigation.

Insertions are planned from the end of the document toward the beginning so offsets remain stable. Multiple hunk insertions at the same canonical offset are combined deterministically. EOF deletions preserve the canonical LF, CRLF, or missing EOF terminator exactly; only newly inserted EOL sequences belong to spacer spans.

## Lifecycle

### Install

1. A comparison produces canonical hunks.
2. The manager verifies that the visible document is not dirty and exactly equals comparison `currentText`.
3. It removes any prior presentation whose display text still matches exactly.
4. It computes a new plan and applies only the insertion edits with no independent undo stops.
5. A display-edit fence recognizes the resulting document event and prevents it from invalidating or recomputing comparison state.
6. The renderer applies red whole-line decorations and deleted attachment text to spacer rows, green decorations to mapped modified rows, and CodeLens actions to the mapped hunk anchor.

If any precondition fails, the extension keeps comparison state but falls back to the current non-spacer Stable decoration presentation for that file.

### Approve or Reject

All four mutating commands continue to share the existing per-file mutation queue.

1. Before resolving a hunk reference, the command removes the installed spacers for that file.
2. Removal must restore text exactly equal to the reference's canonical `expectedText`.
3. The existing Approve or Reject operation runs against canonical offsets.
4. State synchronization installs a fresh spacer plan for any remaining hunks.

If spacer removal cannot be proven safe, the mutation is stopped and an error is shown. The command must not apply a hunk against display offsets.

### Navigation

Review navigation continues to select canonical hunk lines. The host asks the manager to translate the target canonical line to its current display line before revealing it.

### Save

The `onWillSaveTextDocument` listener calls `event.waitUntil(...)` synchronously with deletion edits supplied by the manager. Those edits remove only exact installed spacer spans. The save then writes canonical source. `onDidSaveTextDocument` clears spacer state and accepts the canonical document as the new baseline, matching existing behavior.

If the manager cannot prove an exact presentation match during will-save, it supplies no destructive edits and logs a high-priority error. Normal unexpected-edit handling is responsible for removing or abandoning spacer presentation before a save can reach this state.

### Unexpected User or Extension Edit

The display-edit fence distinguishes manager-owned insertions/removals from other edits.

- If an external edit does not intersect spacer spans, spans are rebased, spacers are removed immediately, and the cleaned text is passed to the normal document-edit comparison path.
- If an edit intersects a spacer row, the extension preserves the edited row as user content, removes only other exact untouched spacer spans, clears the spacer presentation, and recomputes comparison state from the preserved canonicalized document.
- If either transformation is ambiguous, the extension clears decorations and disables spacer presentation for that file. It does not guess and does not delete text.

Moving the cursor into a spacer row proactively removes presentation before typing where possible, but correctness does not depend on selection events.

### Clear, Close, Disable, and Dispose

Clearing a comparison, closing its final visible editor, disabling the extension, or disposing the runtime first requests safe spacer removal. If the live text no longer matches known presentation state, the extension abandons decoration ownership without destructive cleanup and logs the mismatch.

## Components

### `temporaryLineSpacers.ts`

Contains the pure planner, immutable presentation types, offset/line translation, edit rebasing, and `TemporaryLineSpacerManager` lifecycle.

### `displayEditFence.ts`

Matches exact manager-owned content-change events by key, document version, original text, resulting text, and the complete ordered change list. It is separate from review-edit fencing because display edits must return early without invalidating comparison state.

### `inlineRenderer.ts`

Stops using a multiline block attachment. It renders one deleted original line on each real spacer row and maps green ranges through the active spacer plan. Rendering remains restricted to normal text editors.

### `deletedLinesCodeLensProvider.ts`

Receives mapped display anchor lines while retaining canonical `HunkReference` values. Button commands remain unchanged.

### `extension.ts` and `reviewController.ts`

The runtime owns the spacer manager and display-edit fence, supplies will-save cleanup edits synchronously, and routes unexpected edits through cleanup before comparison. The review controller gains a pre-mutation hook that removes spacers inside the existing serialized mutation queue.

## Failure Handling

- All manager operations are revision-guarded so stale asynchronous edits cannot install a presentation.
- A failed insertion rolls back any exact applied spacer edits and falls back to non-spacer rendering.
- A failed or ambiguous removal blocks Approve/Reject instead of applying canonical offsets to display text.
- Cleanup errors are written to the extension output channel without hiding the underlying source.
- No operation removes a span unless ownership and exact text can be demonstrated.

## Known Risks

- While installed, blank lines are real buffer content and are visible to language services, formatters, and extensions.
- Blank lines inside multiline strings can temporarily affect semantic analysis even though they are removed before save.
- A hard extension-host crash followed by saving while the extension remains unavailable can persist spacers. Avoiding this completely requires a virtual document or native diff editor instead of real document mutation.
- Autosave shortens the review window because will-save cleanup accepts the current comparison, consistent with existing save semantics.

These risks are inherent to the requested Stable workaround and cannot be eliminated by decoration APIs.

## Acceptance Criteria

- Every removed original line occupies a real editor row with translucent red background and visible original content.
- Modified lines follow below removed rows without overlap.
- Canonical source, hunk references, and diff computation never include spacer EOLs.
- Approve keeps canonical current text; Reject restores baseline text.
- Save writes canonical text with no extension-owned spacer EOLs.
- LF, CRLF, and missing EOF terminators are preserved.
- User edits are never deleted because they resemble or intersect a spacer.
- Git-clean reset/checkout/restore changes still clear review state.
- On unsupported or ambiguous states, presentation falls back safely instead of mutating source speculatively.
