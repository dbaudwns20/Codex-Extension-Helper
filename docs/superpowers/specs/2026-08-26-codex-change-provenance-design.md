# Exact Codex Change Provenance Design

## Purpose

Change the review pipeline so `Codex Changes` contains only file changes that
can be positively attributed to a completed Codex file-change item. Filesystem
timing and Git status must no longer be used to infer that an unknown external
write came from Codex.

The design deliberately prefers false negatives over false positives. A Codex
write that cannot be proven is hidden rather than mislabeled. Git operations,
user tools, formatters, and other external writers silently advance the
in-memory baseline and never appear in the Codex review UI.

## User Semantics

- A file or hunk appears in `Codex Changes` only after a completed Codex
  file-change item describes the patch and the live file content exactly
  matches the expected post-patch content.
- Git merge, revert, checkout, reset, restore, pull, and other external writes
  are not displayed unless Codex produced a matching completed file-change
  item for the exact resulting content.
- Codex shell commands that mutate files without an exact Codex file-change
  item are not displayed.
- If an unproven write occurs while a file has an active Codex review, that
  file's review is cleared and the new live content becomes its baseline.
- No separate `External Changes` provider is added.
- Approve and reject behavior for proven Codex changes remains unchanged.
- A proven whole-file deletion appears in `Codex Changes`; approving it keeps
  the file deleted, while rejecting it recreates the exact pre-delete content.

## Attribution Boundary

Passive VS Code filesystem and document events contain no writer identity.
They remain useful as wake-up signals but are not evidence of provenance.

Positive attribution comes from the Codex app-server notification stream. The
currently installed Codex protocol exposes file-change item notifications with
`threadId`, `turnId`, `itemId`, paths, change kinds, diffs, and completion
status. The official Codex VS Code extension consumes this stream internally
but does not export it to other extensions, so a version-checked extension-host
patch forwards only the required notifications to Codex Extension Helper.

The forwarder sends:

- `item/fileChange/patchUpdated` notifications;
- `item/completed` notifications whose item type is `fileChange`;
- lifecycle information needed to discard failed, declined, interrupted, or
  stale items.

Turn-level aggregate diffs and elapsed time are not sufficient for positive
attribution and are not accepted as proof.

## Components

### Codex Host Bridge Patch

A new patch module locates the newest compatible `openai.chatgpt-*`
installation and modifies its extension-host bundle, not its webview bundle.
The injected code registers one internal Codex app-server notification handler
and forwards the narrowly selected payloads through a private VS Code command
owned by Codex Extension Helper.

The patch follows the repository's existing safe installation pattern:

- require one exact, versioned source anchor;
- require one start/end marker pair for an installed patch;
- create an adjacent immutable original backup;
- record extension version, patch version, target path, original hash, and
  patched hash in metadata;
- replace the bundle atomically through a sibling temporary file;
- make repeated installation idempotent;
- refuse to patch, migrate, or restore unknown or hash-mismatched state;
- restore only the exact recorded original bytes;
- require a VS Code reload after installation or restoration.

The existing Explorer-drop webview patch remains independent. Installing or
removing the provenance bridge must not change its files or metadata.

### Codex Notification Receiver

The extension registers the private forwarding command during activation. The
receiver validates every payload at runtime and rejects unknown methods,
missing identifiers, unsupported change kinds, malformed paths, paths outside
the current workspace, duplicate lifecycle transitions, and oversized data.

Validated events are converted into internal domain objects; raw app-server
objects do not flow into the comparison coordinator.

### Codex Provenance Ledger

The ledger tracks pending items by `(threadId, turnId, itemId)` and ordered file
changes by normalized URI. Each file record contains:

- the accepted pre-change text and its content hash;
- the normalized patch or add/delete operation;
- the expected post-change text and its content hash;
- item lifecycle status;
- an expiry revision used only for cleanup, never for attribution.

For an update, the ledger applies the unified diff to the exact accepted
pre-change text in memory. An add expects no prior file and a specific complete
content value. A delete expects the exact prior content and absence of the file
after completion. Patch application failure invalidates the entire file record.

Multiple completed Codex items for one file form a hash-linked sequence. A
debounced watcher event may therefore match the final post-image of several
consecutive items without depending on each intermediate filesystem event.

### Provenance Gate

Filesystem create, change, and delete events continue to trigger debounced disk
reads. Before the coordinator receives a candidate, the provenance gate asks
the ledger for a completed exact match.

- Exact pre-image chain and post-image match: consume the matching Codex
  records and call the matching proven create, update, or delete transition
  using the Codex pre-image and verified live post-image.
- A matching item is still in progress: retain the candidate briefly and retry
  when the item reaches a terminal state.
- No matching item has arrived yet: quarantine the candidate for a bounded
  correlation grace period. A later Codex notification can claim it only by an
  exact pre-image and post-image match; expiry silently baselines it.
- No matching completed item, failed item, expired item, malformed patch, or
  content mismatch: discard any candidate and active review for the file, then
  accept the live disk state as the new baseline.

The existing Git-clean test is removed from the attribution decision. Git state
may remain available for diagnostics, but `changed`, `clean`, and `unavailable`
must produce identical provenance behavior when no completed Codex item
matches.

### Comparison State

`FileComparisonState` gains provenance metadata identifying the Codex thread,
turn, item chain, and exact confidence. Its existing `createdFile` boolean is
replaced by a file lifecycle value that distinguishes existing, created, and
deleted files. The coordinator accepts only proven external-change requests;
its diff, stale-reference, and view-synchronization responsibilities remain
otherwise unchanged.

A proven whole-file deletion is represented as a comparison from the exact
pre-delete text to an empty current side with lifecycle `deleted`. Since no live
text editor exists, it is listed in the `Codex Changes` source-control provider
and opens a diff whose empty current side is served by a virtual document.
Approving the deletion accepts the missing file and clears the review.
Rejecting it recreates the exact current baseline through `workspace.fs` after
verifying that the path is still absent and the review reference is current.
The recreated file is not saved through a text editor. A failed or stale
recreation leaves the review intact and reports an error.

Because unknown writes clear the file review before reseeding, the first
implementation does not attempt to preserve or reposition Codex hunks across a
concurrent Git or external edit. This fail-closed rule prevents unrelated lines
from inheriting a Codex label.

## Event Ordering and Races

The file event and Codex notification may arrive in either order.

- If the patch notification arrives first, the ledger waits for the filesystem
  candidate and later completion.
- If the filesystem candidate arrives first, it enters the bounded quarantine;
  timing delays classification but never proves ownership.
- Completion is not sufficient by itself; the final disk content or deletion
  must still match exactly.
- A newer document edit, save, file event, or ledger revision invalidates an
  older asynchronous read or patch computation.
- Unknown writes are never converted into Codex changes merely because they
  occurred during a Codex turn or within a debounce window.
- Pending entries are bounded by count, payload size, and lifetime. Expiry only
  causes a hidden false negative.

Fixed time windows are used only for resource cleanup and waiting for the other
side of a possible correlation. They are never treated as ownership proof; an
exact content chain is required even when both events arrive within the window.

## Failure Handling

- Bridge payload validation failures are logged without changing review state.
- A malformed or unapplicable patch invalidates its file record and causes the
  eventual external write to be silently baselined.
- Failed, declined, or interrupted Codex items never create review state.
- A bridge command that is absent because the helper is disabled is ignored by
  the injected Codex code.
- A helper running without the host bridge stays operational but displays no
  newly detected Codex changes and exposes an actionable bridge status.
- An incompatible Codex update leaves the installation untouched and reports
  that the bridge must be updated.
- Installation and restoration failures must preserve either the verified
  original or the verified patched bundle; unknown partial state fails closed.

## Commands and Configuration

Add explicit commands for the provenance bridge:

- install the Codex provenance bridge;
- remove the Codex provenance bridge;
- show bridge status.

Automatic installation is out of scope. The user must explicitly run the
install command and confirm the external extension modification. The existing
extension enablement, debounce, size, and exclude settings remain unchanged.

## Testing Strategy

### Pure Unit Tests

- payload validation for every accepted and rejected notification shape;
- unified diff application for additions, deletions, modifications, renames,
  CRLF/LF, and missing final newlines;
- exact pre-image and post-image hashing;
- sequential item chaining and collapsed watcher events;
- failed, declined, interrupted, duplicate, stale, oversized, and expired
  entries;
- content mismatch and path traversal rejection.

### Runtime Unit Tests

- Codex notification before and after the watcher event;
- proven create, update, and delete comparisons;
- unproven external create, update, and delete silently reseeding;
- Git state `clean`, `changed`, and `unavailable` producing the same result
  without a matching Codex item;
- merge, revert, checkout, reset, and restore-shaped writes never appearing in
  `Codex Changes` without proof;
- active Codex review clearing on a later unproven write;
- a concurrent user edit causing mismatch and fail-closed cleanup;
- Codex shell-command writes without file-change events remaining hidden;
- stale reads and out-of-order completion not reviving cleared state.

### Patch Tests

- compatible extension-host fixture installation;
- exact notification forwarding injection;
- idempotent reinstall;
- exact restore;
- original, patched, backup, metadata, and marker hash mismatch rejection;
- unsupported Codex version or source anchor rejection;
- partial state rejection;
- coexistence with the Explorer-drop webview patch;
- CLI and VS Code command status/error reporting.

### Extension Host Verification

- apply a representative Codex file-change item and confirm only its exact diff
  appears;
- perform merge and revert operations and confirm no Codex review is created;
- alter a file concurrently with a Codex item and confirm the review fails
  closed;
- install, reload, inspect status, restore, and reload the real compatible Codex
  extension manually after automated tests pass.

## Security and Privacy

Forwarded payloads remain local. The helper stores only in-memory text and
hashes already needed for review and does not add telemetry. Paths are resolved
against workspace roots before use. The bridge forwards only selected
app-server notifications and does not expose a general Codex client or command
execution surface.

## Compatibility and Non-Goals

- The bridge is intentionally version-sensitive and must fail closed after an
  incompatible Codex update.
- Supporting uninstrumented Codex CLI sessions, other agent products, remote
  Codex processes, or arbitrary shell writes is out of scope.
- OS-level writer PID tracking is out of scope.
- Heuristically labeling unknown writes as Codex is prohibited.
- Preserving Codex hunk positions across overlapping unknown writes is out of
  scope for the first implementation.
- A separate UI for external or Git changes is out of scope.
