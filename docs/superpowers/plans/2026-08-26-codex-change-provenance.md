# Exact Codex Change Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a file in `Codex Changes` only when a completed Codex `fileChange` item proves, by exact patch replay and content matching, that Codex produced the observed filesystem transition.

**Architecture:** A separately installable Codex extension-host bridge forwards only internal `fileChange` lifecycle notifications to this extension. A strict protocol parser, unified-patch replay ledger, and bounded watcher quarantine correlate those notifications with actual filesystem candidates. The runtime fails closed: unmatched writes, Git operations, merge/revert results, and shell-command writes without a `fileChange` event silently become the new baseline and clear stale Codex review state. Proven whole-file create/update/delete transitions remain reviewable, including virtual diffs and exact restoration for deleted files.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js ESM, `diff` patch application, SHA-256 via `node:crypto`, Vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-08-26-codex-change-provenance-design.md`

## Global Constraints

- Attribution is fail-closed. Timing, debounce windows, Git status, process names, and active-editor state may delay or invalidate a decision but must never prove Codex ownership.
- A candidate is attributable only when a completed Codex `fileChange` item can be replayed from the last accepted content and the replayed result exactly matches the observed filesystem state.
- `merge`, `rebase`, `cherry-pick`, `revert`, checkout, formatter, user edit, and arbitrary shell-command writes remain hidden unless they independently satisfy the exact event-and-content proof.
- The Codex host bridge forwards only `item/fileChange/patchUpdated` and completed `item/completed` notifications whose item type is `fileChange`; it must not expose a general Codex app-server client.
- Incoming paths must resolve inside an open workspace folder. Invalid schema, oversized payloads, traversal, URI schemes other than `file`, and files outside the workspace are rejected.
- Quarantine timeouts are cleanup boundaries only. Expiration produces an unproven result; elapsed time never changes confidence to proven.
- Unknown writes immediately invalidate any active Codex comparison for that file and silently rebaseline to the observed state (or absence).
- Host patch installation is manual, reversible, marker-versioned, hash-checked, atomic, and independent of the existing Codex Explorer drop/webview patch.
- Existing unrelated worktree changes remain untouched.
- No automatic host patch installation during extension activation.

---

## File Structure

- Create `src/codexProvenanceProtocol.ts`: strict notification types and payload/path/size validation.
- Create `src/unifiedFilePatch.ts`: exact unified-diff replay and UTF-8 SHA-256 helpers.
- Create `src/codexProvenanceLedger.ts`: hash-linked, item-scoped patch chains and completion state.
- Create `src/codexChangeGate.ts`: event/candidate ordering, bounded quarantine, exact-match callbacks, and cleanup.
- Create `src/codexProvenancePatchCommands.ts`: install/remove/status VS Code commands.
- Create `src/codexProvenancePatchRuntime.ts`: adapter from commands to host-patch installer.
- Create `scripts/lib/codex-provenance-source.mjs`: exact host-bundle transform and inverse.
- Create `scripts/lib/codex-provenance-installation.mjs`: discovery, backup, metadata, atomic install, inspection, and restore.
- Create `scripts/patch-codex-provenance.mjs` and `scripts/unpatch-codex-provenance.mjs`: CLI entry points.
- Modify `src/types.ts`: replace `createdFile` with explicit lifecycle and add exact provenance metadata.
- Modify `src/coordinator.ts`: proven create/update/delete transitions and silent external-state acceptance.
- Modify `src/externalChangeDetector.ts`: emit debounced delete candidates instead of immediately deleting state.
- Modify `src/quickDiffBridge.ts`: support a virtual empty current side for deleted-file diffs.
- Modify `src/reviewController.ts`: approve proven deletion or recreate exact deleted content on rejection.
- Modify `src/extension.ts`: register the private notification command, connect the gate, and remove Git status from attribution.
- Modify `package.json`: commands, menus, activation events if required, and patch/unpatch scripts.
- Modify `README.md`: exact-only behavior, bridge installation, limitations, and recovery.
- Create or modify focused unit tests under `test/unit/` for every module above.

### Task 1: Strict Provenance Notification Protocol

**Files:**
- Create: `src/codexProvenanceProtocol.ts`
- Create: `test/unit/codexProvenanceProtocol.test.ts`

**Interfaces:**

```ts
export const CODEX_PROVENANCE_NOTIFICATION_COMMAND =
  'codexExtensionHelper.internal.codexProvenance';

export type CodexFileChangeKind =
  | { readonly type: 'add' }
  | { readonly type: 'delete' }
  | { readonly type: 'update'; readonly move_path: string | null };

export interface CodexFileUpdateChange {
  readonly path: string;
  readonly kind: CodexFileChangeKind;
  readonly diff: string;
}

export type CodexProvenanceNotification =
  | { readonly method: 'item/fileChange/patchUpdated'; readonly params: PatchUpdatedParams }
  | { readonly method: 'item/completed'; readonly params: CompletedFileChangeParams };

export function parseCodexProvenanceNotification(
  value: unknown,
  limits?: { maxChanges: number; maxDiffBytes: number },
): CodexProvenanceNotification | undefined;
```

- [ ] **Step 1: Write failing parser tests**

Cover valid `patchUpdated`, completed `fileChange`, rejected non-file items, incomplete/failed items, missing IDs, unknown methods, extra/invalid kind fields, more than the allowed number of changes, and oversized UTF-8 diffs.

```ts
expect(parseCodexProvenanceNotification({
  method: 'item/completed',
  params: {
    threadId: 'thread-1', turnId: 'turn-1',
    item: { id: 'item-1', type: 'fileChange', status: 'completed', changes: [change] },
  },
})).toMatchObject({ method: 'item/completed' });

expect(parseCodexProvenanceNotification({
  method: 'item/completed',
  params: { threadId: 't', turnId: 'u', item: { id: 'x', type: 'commandExecution' } },
})).toBeUndefined();
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `npx vitest run test/unit/codexProvenanceProtocol.test.ts`

Expected: FAIL because `src/codexProvenanceProtocol.ts` does not exist.

- [ ] **Step 3: Implement a hand-written strict parser**

Use type guards for plain objects, exact string enums, non-empty IDs, an integer maximum change count, and `Buffer.byteLength(diff, 'utf8')`. Normalize nothing and return no partial payload when any nested field is invalid.

- [ ] **Step 4: Run the focused tests**

Run: `npx vitest run test/unit/codexProvenanceProtocol.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/codexProvenanceProtocol.ts test/unit/codexProvenanceProtocol.test.ts
git commit -m "feat: validate Codex provenance notifications"
```

### Task 2: Exact Unified-Patch Replay

**Files:**
- Create: `src/unifiedFilePatch.ts`
- Create: `test/unit/unifiedFilePatch.test.ts`

**Interfaces:**

```ts
export function sha256Text(text: string): string;
export function applyUnifiedFilePatch(beforeText: string, patchText: string): string | undefined;
```

- [ ] **Step 1: Write failing replay tests**

Test additions from empty text, normal edits, deletions to empty text, multiple hunks, CRLF input, final-newline changes, malformed headers, context mismatches, and patches that `diff.applyPatch` rejects.

```ts
expect(applyUnifiedFilePatch('one\ntwo\n', [
  '--- a/file.txt', '+++ b/file.txt',
  '@@ -1,2 +1,2 @@', ' one', '-two', '+three', '',
].join('\n'))).toBe('one\nthree\n');

expect(applyUnifiedFilePatch('unexpected\n', validPatch)).toBeUndefined();
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/unit/unifiedFilePatch.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the wrapper**

Call `applyPatch(beforeText, patchText, { fuzzFactor: 0 })` from `diff`. Return `undefined` for `false` or exceptions. Do not enable fuzzy context matching. Hash UTF-8 content using `createHash('sha256')`.

- [ ] **Step 4: Run focused tests and compile**

Run: `npx vitest run test/unit/unifiedFilePatch.test.ts && npm run compile`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/unifiedFilePatch.ts test/unit/unifiedFilePatch.test.ts
git commit -m "feat: replay Codex file patches exactly"
```

### Task 3: Hash-Linked Provenance Ledger

**Files:**
- Create: `src/codexProvenanceLedger.ts`
- Create: `test/unit/codexProvenanceLedger.test.ts`

**Interfaces:**

```ts
export interface ProvenanceFileState {
  readonly uri: vscode.Uri;
  readonly exists: boolean;
  readonly text: string;
}

export interface ExactCodexTransition {
  readonly key: string;
  readonly uri: vscode.Uri;
  readonly before: ProvenanceFileState;
  readonly after: ProvenanceFileState;
  readonly provenance: {
    readonly confidence: 'exact';
    readonly threadId: string;
    readonly turnId: string;
    readonly itemIds: readonly string[];
  };
}

export class CodexProvenanceLedger {
  record(notification: CodexProvenanceNotification): void;
  completedTransitions(
    resolvePath: (path: string) => ProvenanceFileState | undefined,
  ): readonly ExactCodexTransition[];
  consume(key: string, afterHash: string): ExactCodexTransition | undefined;
  invalidate(key: string): void;
  prune(now: number): void;
}
```

- [ ] **Step 1: Write failing ledger tests**

Cover patch-before-completion, completion-before-final-patch update, duplicate notifications, one item changing several files, sequential items changing one file, add/update/delete chains, wrong starting hash, malformed patch replay, move paths, and expired entries.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/unit/codexProvenanceLedger.test.ts`

Expected: FAIL because the ledger does not exist.

- [ ] **Step 3: Implement item identity and exact chains**

Use `${threadId}\0${turnId}\0${itemId}` as the internal item key. Keep the last patch list per item and mark it eligible only after a completed item notification. For each path, replay changes from a supplied accepted snapshot, requiring the declared add/update/delete lifecycle to match existence and requiring every link's `beforeHash` to equal the preceding link's `afterHash`. Treat `move_path` as unsupported in v1 unless both source and destination can be proven atomically; unsupported moves produce no transition.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run test/unit/codexProvenanceLedger.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/codexProvenanceLedger.ts test/unit/codexProvenanceLedger.test.ts
git commit -m "feat: track exact Codex file transitions"
```

### Task 4: Event/Watcher Correlation Gate

**Files:**
- Create: `src/codexChangeGate.ts`
- Create: `test/unit/codexChangeGate.test.ts`

**Interfaces:**

```ts
export type FileSystemCandidate =
  | { readonly kind: 'present'; readonly key: string; readonly uri: vscode.Uri; readonly text: string }
  | { readonly kind: 'absent'; readonly key: string; readonly uri: vscode.Uri };

export interface CodexChangeGateCallbacks {
  onProven(transition: ExactCodexTransition): Promise<void>;
  onUnproven(candidate: FileSystemCandidate): Promise<void>;
}

export class CodexChangeGate implements vscode.Disposable {
  handleNotification(value: unknown): Promise<void>;
  handleCandidate(candidate: FileSystemCandidate): Promise<void>;
  dispose(): void;
}
```

- [ ] **Step 1: Write failing ordering and quarantine tests**

Use a fake clock. Cover event-first, watcher-first, exact match, mismatched content, timeout, duplicate watcher events, a newer candidate superseding an older one, delete candidates, invalid notification payloads, and disposal. Assert that timeout invokes `onUnproven` and never `onProven`.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/unit/codexChangeGate.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement bounded correlation**

Keep at most one candidate per normalized workspace key and a bounded list of eligible transitions. A candidate matches only equal existence plus equal SHA-256 content. Run matching after either input arrives. On replacement/expiry, call `onUnproven`; do not silently discard filesystem state.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run test/unit/codexChangeGate.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/codexChangeGate.ts test/unit/codexChangeGate.test.ts
git commit -m "feat: correlate Codex events with filesystem changes"
```

### Task 5: Explicit File Lifecycle and Proven Deletions

**Files:**
- Modify: `src/types.ts`
- Modify: `src/coordinator.ts`
- Modify: `src/snapshotStore.ts`
- Modify: `test/unit/coordinator.test.ts`
- Modify: `test/unit/snapshotStore.test.ts`

**Interfaces:**

```ts
export type FileLifecycle = 'existing' | 'created' | 'deleted';

export interface ExactCodexProvenance {
  readonly confidence: 'exact';
  readonly threadId: string;
  readonly turnId: string;
  readonly itemIds: readonly string[];
}

// FileComparisonState
readonly lifecycle: FileLifecycle;
readonly provenance: ExactCodexProvenance;

// Coordinator additions
provenChange(key: string, beforeText: string, afterText: string,
  lifecycle: FileLifecycle, provenance: ExactCodexProvenance): Promise<void>;
acceptExternalState(key: string, currentText: string | undefined): Promise<void>;
```

- [ ] **Step 1: Replace test fixtures and add failing lifecycle tests**

Change `createdFile` fixtures to `lifecycle`. Add tests for proven update, create from absence, delete to absence, unknown present rebaseline, unknown absence state removal, and unknown writes clearing an active Codex comparison.

- [ ] **Step 2: Verify the expected type/test failures**

Run: `npx vitest run test/unit/coordinator.test.ts test/unit/snapshotStore.test.ts`

Expected: FAIL until implementation is updated.

- [ ] **Step 3: Implement lifecycle-aware state**

Persist accepted content separately from active comparison content. A deleted comparison retains its exact pre-delete baseline and uses `currentText: ''`; accepting an unknown absence removes the accepted snapshot and active state. Provenance must be immutable on the comparison state and replaced only by a newer exact transition.

- [ ] **Step 4: Run focused tests and compile**

Run: `npx vitest run test/unit/coordinator.test.ts test/unit/snapshotStore.test.ts && npm run compile`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/coordinator.ts src/snapshotStore.ts test/unit/coordinator.test.ts test/unit/snapshotStore.test.ts
git commit -m "feat: model proven Codex file lifecycles"
```

### Task 6: Deleted-File Review and Virtual Diff

**Files:**
- Modify: `src/quickDiffBridge.ts`
- Modify: `src/reviewController.ts`
- Modify: `src/extension.ts`
- Modify: `test/unit/reviewController.test.ts`
- Modify: `test/unit/packageRuntime.test.ts`

- [ ] **Step 1: Add failing deleted-file review tests**

Assert that a deleted comparison appears in SCM, opens `baseline -> empty virtual current`, approve keeps the file absent and clears state, reject recreates the exact baseline only when the path is still absent, and reject refuses to overwrite a newly recreated/stale path.

```ts
await controller.rejectFile(deletedState);
expect(host.restoreDeletedFile).toHaveBeenCalledWith(uri, 'before\n');
expect(coordinator.getState(key)?.comparisonActive).toBe(false);
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/unit/reviewController.test.ts test/unit/packageRuntime.test.ts`

Expected: FAIL.

- [ ] **Step 3: Add a virtual current-content provider**

Store both sides by review entry. Existing/created files continue to use the live resource as the right side; deleted files use a read-only virtual URI containing `''`. Keep quick-diff baseline behavior unchanged for live files.

- [ ] **Step 4: Implement guarded deletion decisions**

Before approving, confirm the file remains absent. Before rejecting, confirm absence and recreate the baseline with `workspace.fs.writeFile`. If the path exists, show a stale-state warning and leave the comparison active. Do not route deleted files through text-editor hunk operations.

- [ ] **Step 5: Run focused tests and compile**

Run: `npx vitest run test/unit/reviewController.test.ts test/unit/packageRuntime.test.ts && npm run compile`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/quickDiffBridge.ts src/reviewController.ts src/extension.ts test/unit/reviewController.test.ts test/unit/packageRuntime.test.ts
git commit -m "feat: review proven Codex file deletions"
```

### Task 7: Filesystem Candidate Flow and Exact-Only Runtime

**Files:**
- Modify: `src/externalChangeDetector.ts`
- Modify: `src/extension.ts`
- Modify: `test/unit/externalChangeDetector.test.ts`
- Modify: `test/unit/packageRuntime.test.ts`

- [ ] **Step 1: Write failing exact-only integration tests**

Cover:

- Codex notification then matching watcher change -> visible `Codex Changes`.
- Watcher change then matching completed event -> visible.
- Merge/revert-style watcher updates with dirty Git state but no event -> hidden and rebaselined.
- Event with different output bytes -> hidden.
- Shell-command write with no `fileChange` event -> hidden.
- Unknown write while a Codex review is active -> review cleared and new baseline accepted.
- Unknown delete -> state removed.

- [ ] **Step 2: Verify failures**

Run: `npx vitest run test/unit/externalChangeDetector.test.ts test/unit/packageRuntime.test.ts`

Expected: FAIL under the current debounce/Git guard behavior.

- [ ] **Step 3: Emit delete candidates**

Change the detector callback contract so create/change produces a `present` candidate and delete produces an `absent` candidate after the same bounded debounce. Preserve existing read-race handling, but never delete coordinator state directly from the watcher.

- [ ] **Step 4: Wire the gate into `ExtensionRuntime`**

Register `CODEX_PROVENANCE_NOTIFICATION_COMMAND` as an internal command. Route validated notifications to `CodexChangeGate.handleNotification` and watcher events to `handleCandidate`. Route `onProven` to `coordinator.provenChange`; route `onUnproven` to `coordinator.acceptExternalState`. Remove `GitChangeGuard.resourceState()` from the attribution decision and dispose the guard if it has no remaining non-attribution use.

- [ ] **Step 5: Run focused tests and compile**

Run: `npx vitest run test/unit/externalChangeDetector.test.ts test/unit/packageRuntime.test.ts && npm run compile`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/externalChangeDetector.ts src/extension.ts test/unit/externalChangeDetector.test.ts test/unit/packageRuntime.test.ts
git commit -m "feat: show only exact Codex filesystem changes"
```

### Task 8: Reversible Codex Host Source Transform

**Files:**
- Create: `scripts/lib/codex-provenance-source.mjs`
- Create: `test/unit/codexProvenanceSource.test.ts`

**Interfaces:**

```js
export const PROVENANCE_BRIDGE_VERSION = 1;
export const PROVENANCE_START_MARKER = '/* codex-extension-helper:provenance:start:v1 */';
export const PROVENANCE_END_MARKER = '/* codex-extension-helper:provenance:end:v1 */';
export function patchCodexHostSource(source) {};
export function unpatchCodexHostSource(source) {};
```

- [ ] **Step 1: Build a representative minified fixture and failing tests**

The fixture must contain a Codex app-server client and its existing `registerInternalNotificationHandler` registration. Test one exact insertion, idempotence, exact inverse restoration, missing anchor, duplicate anchor, duplicate/reversed/unsupported markers, and unrelated `registerInternalNotificationHandler` calls.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/unit/codexProvenanceSource.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the narrow forwarder transform**

Capture the existing subscription collection, app-server client identifier, and imported VS Code namespace from verified anchors. Insert one registration before the existing notification handler:

```js
subscriptions.push(client.registerInternalNotificationHandler(event => {
  const isPatch = event?.method === 'item/fileChange/patchUpdated';
  const isCompletedFileChange = event?.method === 'item/completed'
    && event?.params?.item?.type === 'fileChange'
    && event?.params?.item?.status === 'completed';
  if (isPatch || isCompletedFileChange) {
    void vscode.commands.executeCommand(
      'codexExtensionHelper.internal.codexProvenance', event,
    ).then(() => undefined, () => undefined);
  }
}));
```

Encode the exact inserted fragment between versioned markers. Refuse to patch unless every required anchor occurs exactly once.

- [ ] **Step 4: Test against the currently installed Codex bundle read-only**

Run a Node one-liner that reads the discovered `out/extension.js`, applies `patchCodexHostSource` in memory, then applies `unpatchCodexHostSource` and asserts byte-for-byte equality. Do not write to the installed extension in this step.

Expected: one supported anchor and exact round trip.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run test/unit/codexProvenanceSource.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/codex-provenance-source.mjs test/unit/codexProvenanceSource.test.ts
git commit -m "feat: patch Codex host provenance bridge"
```

### Task 9: Independent Host-Patch Installation Lifecycle

**Files:**
- Create: `scripts/lib/codex-provenance-installation.mjs`
- Create: `test/unit/codexProvenanceInstallation.test.ts`
- Create: `scripts/patch-codex-provenance.mjs`
- Create: `scripts/unpatch-codex-provenance.mjs`
- Create: `test/unit/codexProvenanceCli.test.ts`

**Interfaces:**

```js
export function inspectCodexProvenancePatch(installation) {};
export function applyCodexProvenancePatch(installation) {};
export function restoreCodexProvenancePatch(installation) {};
```

- [ ] **Step 1: Write failing installation tests**

Use temporary fake Codex installations. Cover fresh install, backup creation, metadata with version/original hash/patched hash/target path, idempotent install, clean restore, missing backup, modified patched target, stale metadata, unsupported source, atomic-write failure, and coexistence with the unrelated webview patch metadata.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/unit/codexProvenanceInstallation.test.ts test/unit/codexProvenanceCli.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement hash-checked atomic lifecycle**

Target only `out/extension.js`. Use a provenance-specific backup and metadata filename. Write temporary files in the target directory, fsync/close when practical, and rename atomically. Restore only if the installed file hash equals the recorded patched hash; otherwise fail without overwriting user/vendor changes.

- [ ] **Step 4: Implement CLIs**

The patch CLI reports the selected Codex installation and says VS Code must be reloaded. The unpatch CLI reports restoration and the same reload requirement. Neither CLI touches webview patch files.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run test/unit/codexProvenanceInstallation.test.ts test/unit/codexProvenanceCli.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/codex-provenance-installation.mjs scripts/patch-codex-provenance.mjs scripts/unpatch-codex-provenance.mjs test/unit/codexProvenanceInstallation.test.ts test/unit/codexProvenanceCli.test.ts
git commit -m "feat: manage Codex provenance host patch"
```

### Task 10: VS Code Commands, Manifest, and Documentation

**Files:**
- Create: `src/codexProvenancePatchCommands.ts`
- Create: `src/codexProvenancePatchRuntime.ts`
- Create: `test/unit/codexProvenancePatchCommands.test.ts`
- Create: `test/unit/codexProvenancePatchRuntime.test.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Write failing command/runtime tests**

Test install confirmation, already-installed status, removal confirmation, tamper errors, missing Codex installation, reload prompt, and status output. Verify no installer runs during extension activation.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/unit/codexProvenancePatchCommands.test.ts test/unit/codexProvenancePatchRuntime.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement command adapters and manifest entries**

Add commands named:

- `codexExtensionHelper.installProvenanceBridge`
- `codexExtensionHelper.removeProvenanceBridge`
- `codexExtensionHelper.showProvenanceBridgeStatus`

Register them during activation, but invoke file mutation only after the explicit command and confirmation. Add `patch:codex-provenance` and `unpatch:codex-provenance` package scripts.

- [ ] **Step 4: Update README**

Document:

- Why debounce/Git status cannot establish authorship.
- Exact-only semantics and expected false negatives.
- That Codex shell-command writes without a `fileChange` item are intentionally hidden.
- Install/remove/status commands and required VS Code reload.
- Backup/tamper recovery and supported-version failure behavior.
- Whole-file deletion approval/rejection behavior.

- [ ] **Step 5: Run focused tests and package checks**

Run: `npx vitest run test/unit/codexProvenancePatchCommands.test.ts test/unit/codexProvenancePatchRuntime.test.ts && npm run compile`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/codexProvenancePatchCommands.ts src/codexProvenancePatchRuntime.ts src/extension.ts package.json README.md test/unit/codexProvenancePatchCommands.test.ts test/unit/codexProvenancePatchRuntime.test.ts
git commit -m "feat: expose exact Codex provenance bridge"
```

### Task 11: End-to-End Regression and Manual Bridge Verification

**Files:**
- Modify: `test/unit/packageRuntime.test.ts`
- Modify: `test/unit/gitChangeGuard.test.ts` (remove attribution expectations or delete only if the module is now unused)
- Modify: `docs/superpowers/plans/2026-08-26-codex-change-provenance.md` (checkbox tracking only)

- [x] **Step 1: Add the final regression matrix**

Create one table-driven runtime test that asserts visibility for all combinations:

| Filesystem result | Exact completed fileChange | Exact bytes | Expected |
|---|---:|---:|---|
| create/update/delete | yes | yes | shown |
| create/update/delete | yes | no | hidden/rebaseline |
| merge/revert/Git write | no | n/a | hidden/rebaseline |
| shell command write | no | n/a | hidden/rebaseline |
| user/formatter write | no | n/a | hidden/rebaseline |

- [x] **Step 2: Run all automated verification**

Run:

```bash
npm run check
npm run package
```

Expected: TypeScript compilation, all unit tests, and VSIX packaging PASS.

- [x] **Step 3: Inspect the final diff**

Run:

```bash
git status --short
git diff --check
git diff --stat HEAD~10..HEAD
```

Confirm no unrelated changes, no placeholder text (`TODO`, `FIXME`, `stub`, `later`), and no remaining attribution branch based on `GitChangeGuard` or debounce expiry.

- [ ] **Step 4: Manually install only with explicit approval**

Run the provenance patch CLI against the discovered installed Codex extension. Because this writes outside the repository, request escalation at execution time. Reload VS Code, trigger one Codex file edit and one manual/Git edit, and verify only the exact Codex edit appears. Then run status inspection and ensure recorded hashes match.

- [ ] **Step 5: Commit final regression adjustments**

```bash
git add test/unit/packageRuntime.test.ts test/unit/gitChangeGuard.test.ts docs/superpowers/plans/2026-08-26-codex-change-provenance.md
git commit -m "test: verify exact-only Codex attribution"
```

---

## Plan Self-Review

- Spec coverage: host forwarding, validation, exact patch replay, both event orderings, fixed quarantine, unknown-write invalidation, exact-only visibility, create/update/delete lifecycle, reversible installation, commands, docs, and manual verification are each mapped to a task.
- Type flow: host payload -> strict parser -> ledger transition -> gate match -> coordinator `ExactCodexProvenance` -> immutable `FileComparisonState` -> review UI.
- Failure policy: invalid/unsupported/mismatched inputs never become Codex changes; watcher candidates always end in either exact proof or silent external-state acceptance.
- Placeholder scan: the plan specifies concrete public signatures, command IDs, marker strings, test commands, and commit boundaries; no implementation placeholder is permitted.
- Scope check: the existing Codex Explorer drop/webview patch remains independent and is not automatically modified or installed.
