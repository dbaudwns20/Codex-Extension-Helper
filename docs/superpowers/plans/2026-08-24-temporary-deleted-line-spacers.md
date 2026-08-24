# Temporary Deleted-Line Spacers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert extension-owned blank document rows for deleted lines so removed and modified content render vertically without overlap, while guaranteeing that canonical source, saves, Approve, and Reject never include those rows.

**Architecture:** A pure spacer planner builds exact canonical/display mappings and removal spans. A revision-guarded manager applies those edits through an exact display-edit fence, while the renderer and review UI consume mapped display coordinates and the coordinator continues to own canonical text only. Save and review commands remove spacers before operating; unexpected edits preserve user text and remove only provably untouched spacer spans.

**Tech Stack:** TypeScript 5.9, VS Code Stable Extension API 1.105+, existing `LineDiffEngine`, `ComparisonCoordinator`, `ReviewController`, `WorkspaceEdit`, `TextDocumentWillSaveEvent.waitUntil`.

**Spec:** `docs/superpowers/specs/2026-08-24-temporary-deleted-line-spacers-design.md`

## Global Constraints

- VS Code Stable only; do not add `enabledApiProposals` or `editorInsets`.
- Canonical source written by Codex remains the only input to diff computation and hunk references.
- Approve keeps canonical current source; Reject restores the baseline.
- Save removes every provably owned spacer before writing and then accepts canonical text.
- Preserve exact LF, CRLF, and missing EOF terminators.
- Never remove user-authored text merely because it resembles a spacer.
- Keep existing Git-clean reset/checkout/restore suppression.
- Keep current CodeLens Approve/Reject and editor-title navigation/all-actions.
- Per explicit user instruction, do not add or run automated tests. Use TypeScript compilation, `git diff --check`, VSIX packaging, and archive integrity checks only.
- Preserve all unrelated and previously requested uncommitted changes.

---

### Task 1: Pure Spacer Plan and Coordinate Mapping

**Files:**
- Create: `src/temporaryLineSpacers.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: `ChangeHunk`, canonical document text, and `vscode.EndOfLine`-derived `"\n" | "\r\n"`.
- Produces:
  - `createTemporaryLineSpacerPlan(canonicalText: string, eol: "\n" | "\r\n", hunks: readonly ChangeHunk[]): TemporaryLineSpacerPlan`
  - `TemporaryLineSpacerPlan.displayText`
  - `TemporaryLineSpacerPlan.insertions`
  - `TemporaryLineSpacerPlan.spans`
  - `TemporaryLineSpacerPlan.hunks`
  - `TemporaryLineSpacerPlan.displayLineForCanonical(line: number): number`

- [ ] **Step 1: Add display-coordinate types without changing canonical hunk types**

Add these focused types to `src/temporaryLineSpacers.ts`; do not add display fields to `ChangeHunk`:

```ts
import type { ChangeHunk } from './types';

export interface SpacerTextEdit {
  readonly offset: number;
  readonly length: number;
  readonly text: string;
}

export interface SpacerSpan {
  readonly displayStart: number;
  readonly displayEnd: number;
  readonly text: string;
  readonly hunkIndex: number;
  readonly originalLineIndex: number;
  readonly displayLine: number;
}

export interface DisplayHunkMapping {
  readonly hunkIndex: number;
  readonly actionLine: number;
  readonly removedRows: readonly {
    readonly line: number;
    readonly text: string;
  }[];
  readonly modifiedStart: number;
  readonly modifiedEnd: number;
}

export interface TemporaryLineSpacerPlan {
  readonly canonicalText: string;
  readonly displayText: string;
  readonly eol: '\n' | '\r\n';
  readonly insertions: readonly SpacerTextEdit[];
  readonly spans: readonly SpacerSpan[];
  readonly hunks: readonly DisplayHunkMapping[];
  displayLineForCanonical(line: number): number;
}
```

- [ ] **Step 2: Implement canonical line starts and stable insertion anchors**

Implement private helpers that preserve the input terminator exactly:

```ts
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

function offsetForLine(text: string, starts: readonly number[], line: number): number {
  if (line <= 0) return 0;
  if (line >= starts.length) return text.length;
  return starts[line];
}
```

Group all deleted-row insertions by canonical offset. Sort groups by offset and hunk index for mapping, but expose `insertions` in descending offset order for direct `WorkspaceEdit.insert` application.

- [ ] **Step 3: Build exact display text, spans, and hunk mappings**

Implement:

```ts
export function createTemporaryLineSpacerPlan(
  canonicalText: string,
  eol: '\n' | '\r\n',
  hunks: readonly ChangeHunk[],
): TemporaryLineSpacerPlan
```

For each `hunk.originalLines` entry, insert exactly one `eol`. Compute `displayText` by applying insertions from highest offset to lowest. Then walk insertions in ascending display order to record each owned EOL as a separate `SpacerSpan` and to map:

- deleted rows to their real blank display lines;
- modified ranges after cumulative inserted rows;
- `actionLine` to the first removed row for a deletion/modification, otherwise the first modified row;
- canonical navigation lines through `displayLineForCanonical`.

Do not normalize or append a canonical EOF terminator. Every character absent from `canonicalText` must belong to a recorded span.

- [ ] **Step 4: Add pure unexpected-edit reconciliation**

Export:

```ts
export interface DisplayContentChange {
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly text: string;
}

export interface SpacerReconciliation {
  readonly textAfterUserEdit: string;
  readonly canonicalizedText: string;
  readonly cleanupEdits: readonly SpacerTextEdit[];
  readonly intersectedSpacerCount: number;
}

export function reconcileSpacerEdit(
  plan: TemporaryLineSpacerPlan,
  changes: readonly DisplayContentChange[],
): SpacerReconciliation | undefined
```

Validate ordered, non-overlapping changes against `plan.displayText`. Apply changes from the end. Rebase untouched spacer spans through all earlier changes and generate descending cleanup deletions only when the rebased slice still equals `span.text`. Treat boundary insertion on an empty spacer row as intersecting and preserve it. Return `undefined` on invalid ranges, overlapping changes, or an untouched span whose exact EOL can no longer be proven.

- [ ] **Step 5: Compile and inspect the pure boundary**

Run:

```bash
npm run compile
git diff --check -- src/temporaryLineSpacers.ts src/types.ts
```

Expected: TypeScript exit `0`; no whitespace errors; no references to `vscode.window`, coordinator state, or renderer resources in `temporaryLineSpacers.ts`.

- [ ] **Step 6: Commit the pure planner**

```bash
git add src/temporaryLineSpacers.ts src/types.ts
git commit -m "feat: plan temporary deleted line spacers"
```

---

### Task 2: Exact Display-Edit Fence

**Files:**
- Create: `src/displayEditFence.ts`

**Interfaces:**
- Consumes: expected pre-edit/post-edit text, starting document version, and exact edit list from the spacer manager.
- Produces:
  - `DisplayEditFence.begin(expectation: DisplayEditExpectation): () => void`
  - `DisplayEditFence.consume(event: DisplayEditEvent): boolean`
  - `DisplayEditFence.invalidate(key: string): void`
  - `DisplayEditFence.clear(): void`

- [ ] **Step 1: Define exact display-edit expectations**

```ts
export interface DisplayEditExpectation {
  readonly key: string;
  readonly startingVersion: number;
  readonly originalText: string;
  readonly resultingText: string;
  readonly changes: readonly {
    readonly rangeOffset: number;
    readonly rangeLength: number;
    readonly text: string;
  }[];
}

export interface DisplayEditEvent {
  readonly key: string;
  readonly documentVersion: number;
  readonly originalText: string;
  readonly resultingText: string;
  readonly changes: DisplayEditExpectation['changes'];
}
```

- [ ] **Step 2: Implement one pending expectation per document key**

The implementation must compare version, original/resulting text, change count, and every ordered change tuple. `consume` always deletes the pending expectation before returning so a near-match cannot be reused. `begin` returns a finish callback that removes only the same expectation object.

```ts
export class DisplayEditFence {
  private readonly pending = new Map<string, DisplayEditExpectation>();
  begin(expectation: DisplayEditExpectation): () => void;
  consume(event: DisplayEditEvent): boolean;
  invalidate(key: string): void;
  clear(): void;
}
```

- [ ] **Step 3: Compile and inspect exact matching**

```bash
npm run compile
git diff --check -- src/displayEditFence.ts
```

Expected: exit `0`; `consume` contains no partial-match or text-only acceptance path.

- [ ] **Step 4: Commit the fence**

```bash
git add src/displayEditFence.ts
git commit -m "feat: fence temporary display edits"
```

---

### Task 3: Temporary Spacer Lifecycle Manager

**Files:**
- Modify: `src/temporaryLineSpacers.ts`
- Modify: `src/disposableStore.ts` only if the manager needs the existing ownership helper; otherwise leave it unchanged.

**Interfaces:**
- Consumes: planner output, visible text documents/editors, `DisplayEditFence`, and a host that applies exact text edits.
- Produces:
  - `TemporaryLineSpacerManager.install(request: SpacerInstallRequest): Promise<InstalledSpacerPresentation | undefined>`
  - `TemporaryLineSpacerManager.remove(key: string): Promise<SpacerRemovalResult>`
  - `TemporaryLineSpacerManager.reconcileUnexpectedChange(event: SpacerDocumentChange): Promise<SpacerUnexpectedEditResult | undefined>`
  - `TemporaryLineSpacerManager.willSaveEdits(document: SpacerDocument): readonly SpacerTextEdit[]`
  - mapping accessors for renderer, CodeLens, and navigation.

- [ ] **Step 1: Define the manager host boundary**

Keep VS Code mutation details outside the pure plan:

```ts
export interface SpacerDocument {
  readonly key: string;
  readonly text: string;
  readonly version: number;
  readonly isDirty: boolean;
  readonly eol: '\n' | '\r\n';
}

export interface SpacerEditHost {
  document(key: string): SpacerDocument | undefined;
  apply(
    document: SpacerDocument,
    edits: readonly SpacerTextEdit[],
    expectedText: string,
  ): Promise<boolean>;
  log(scope: string, error: unknown): void;
}

export interface SpacerInstallRequest {
  readonly key: string;
  readonly canonicalText: string;
  readonly hunks: readonly ChangeHunk[];
}

export interface InstalledSpacerPresentation {
  readonly key: string;
  readonly canonicalText: string;
  readonly displayText: string;
  readonly documentVersion: number;
  readonly revision: number;
  readonly plan: TemporaryLineSpacerPlan;
}

export interface SpacerDocumentChange {
  readonly key: string;
  readonly documentVersion: number;
  readonly resultingText: string;
  readonly changes: readonly DisplayContentChange[];
}

export type SpacerUnexpectedEditResult =
  | { readonly status: 'canonicalized'; readonly text: string }
  | { readonly status: 'unsafe' };

export class TemporaryLineSpacerManager {
  constructor(
    host: SpacerEditHost,
    fence: DisplayEditFence,
  );
  install(request: SpacerInstallRequest): Promise<InstalledSpacerPresentation | undefined>;
  remove(key: string): Promise<SpacerRemovalResult>;
  reconcileUnexpectedChange(
    event: SpacerDocumentChange,
  ): Promise<SpacerUnexpectedEditResult | undefined>;
  willSaveEdits(document: SpacerDocument): readonly SpacerTextEdit[];
  presentation(key: string): InstalledSpacerPresentation | undefined;
  displayLine(key: string, canonicalLine: number): number;
  clear(key: string): Promise<SpacerRemovalResult>;
  clearAll(): Promise<void>;
  dispose(): void;
}
```

- [ ] **Step 2: Implement revision-guarded install**

`install` must:

1. increment a per-key revision;
2. remove an exact prior presentation;
3. require a non-dirty live document equal to `canonicalText`;
4. build a plan with the document EOL;
5. skip mutation when the plan has no spans;
6. arm `DisplayEditFence` before applying descending insertion edits;
7. require the resulting live text/version to equal `plan.displayText` and `startingVersion + 1`;
8. store an immutable `InstalledSpacerPresentation` only if the revision is still current.

Return `undefined` and log/fall back if any condition fails. If an edit was applied but final verification fails, remove only exact owned spans that remain provable.

- [ ] **Step 3: Implement safe exact removal and pre-mutation removal**

Define:

```ts
export type SpacerRemovalResult =
  | { readonly status: 'removed'; readonly canonicalText: string }
  | { readonly status: 'absent' }
  | { readonly status: 'unsafe' };
```

When live text exactly equals `plan.displayText`, delete all spans in descending display-offset order under the display fence and require the result to equal `plan.canonicalText`. On mismatch return `unsafe`; never replace the entire document with cached canonical text.

- [ ] **Step 4: Implement unexpected-edit cleanup**

Use `reconcileSpacerEdit`. Apply only returned `cleanupEdits`, fenced as manager-owned. Return the exact final canonicalized text to the runtime for `coordinator.documentEdit`. If reconciliation is `undefined`, clear presentation ownership and return an explicit `unsafe` result without applying edits.

- [ ] **Step 5: Implement synchronous will-save edit extraction**

`willSaveEdits` must be synchronous. It returns descending deletion edits only when document key, version, and full text match an installed presentation exactly. It invalidates manager ownership immediately so later render work cannot reuse the plan. The runtime converts these offsets to `vscode.TextEdit` objects before passing them to `waitUntil`.

- [ ] **Step 6: Add mapping and cleanup accessors**

```ts
presentation(key: string): InstalledSpacerPresentation | undefined;
displayLine(key: string, canonicalLine: number): number;
clear(key: string): Promise<SpacerRemovalResult>;
clearAll(): Promise<void>;
dispose(): void;
```

`dispose` invalidates revisions and drops ownership only after requesting exact cleanup through runtime shutdown ordering.

- [ ] **Step 7: Compile and inspect destructive operations**

```bash
npm run compile
rg -n "replaceAll|canonicalText" src/temporaryLineSpacers.ts
git diff --check -- src/temporaryLineSpacers.ts
```

Expected: compilation exit `0`; no cleanup path performs a whole-document replacement from cached canonical text; every deletion originates from exact recorded spans.

- [ ] **Step 8: Commit the lifecycle manager**

```bash
git add src/temporaryLineSpacers.ts
git commit -m "feat: manage temporary deleted line spacers"
```

---

### Task 4: Render Real Spacer Rows and Map Review Controls

**Files:**
- Modify: `src/inlineRenderer.ts`
- Modify: `src/deletedLinesCodeLensProvider.ts`
- Modify: `src/extension.ts` synchronization interfaces only

**Interfaces:**
- Consumes: `InstalledSpacerPresentation.plan.hunks` and canonical `HunkReference` state.
- Produces:
  - red whole-line decorations on real spacer rows;
  - green whole-line decorations on mapped modified rows;
  - CodeLens action anchors at mapped `actionLine` while command arguments remain canonical.

- [ ] **Step 1: Replace multiline attachment rendering with real-row decorations**

Create a removed decoration type with whole-line background and render one option per mapped removed row:

```ts
const option: vscode.DecorationOptions = {
  range: new api.Range(row.line, 0, row.line, 0),
  renderOptions: {
    after: {
      contentText: `− ${row.text || '(blank line)'}`,
      color: new api.ThemeColor('editor.foreground'),
      backgroundColor: new api.ThemeColor('diffEditor.removedTextBackground'),
    },
  },
};
```

Remove CSS-injection strings containing `display: block`, `width: 100%`, or embedded newline content.

- [ ] **Step 2: Change renderer input to installed display mappings**

Update the runtime-facing renderer boundary to:

```ts
render(
  key: string,
  hunks: readonly ChangeHunk[],
  presentation?: InstalledSpacerPresentation,
): Promise<void>;
```

When a presentation exists, use mapped display coordinates. Without one, retain the existing Stable fallback: green canonical ranges plus the current non-spacer removed attachment.

- [ ] **Step 3: Map CodeLens anchors without changing hunk references**

Extend review state:

```ts
export interface ReviewCodeLensState {
  readonly key: string;
  readonly sourceRevision: number;
  readonly currentText: string;
  readonly hunks: readonly ChangeHunk[];
  readonly actionLines?: readonly number[];
}
```

Use `actionLines?.[hunkIndex]` when present, otherwise `hunk.modifiedStart`. Keep `expectedText: state.currentText`, `sourceRevision`, and `hunkIndex` unchanged. Keep CodeLens, not Inlay Hints.

- [ ] **Step 4: Sequence synchronization after spacer installation**

Change `synchronizeReviewViews` so active visible files install spacers first, then pass the same immutable presentation to renderer and CodeLens. Quick Diff continues to receive canonical baseline text. If installation returns `undefined`, render the fallback.

- [ ] **Step 5: Compile and scan for overlay CSS**

```bash
npm run compile
rg -n "display: block|white-space: pre|join\('\\n'\)" src/inlineRenderer.ts
git diff --check -- src/inlineRenderer.ts src/deletedLinesCodeLensProvider.ts src/extension.ts
```

Expected: compile exit `0`; overlay scan returns no match in the removed-row path.

- [ ] **Step 6: Commit mapped presentation**

```bash
git add src/inlineRenderer.ts src/deletedLinesCodeLensProvider.ts src/extension.ts
git commit -m "feat: render deleted lines on temporary rows"
```

---

### Task 5: Integrate Review Mutations, Navigation, Save, and Unexpected Edits

**Files:**
- Modify: `src/reviewController.ts`
- Modify: `src/extension.ts`
- Modify: `src/documentChangeFence.ts` only if shared event normalization is extracted; otherwise leave unchanged.

**Interfaces:**
- Consumes: spacer manager removal/reconciliation, existing review mutation queue, workspace save events.
- Produces: canonical-only Approve/Reject, mapped navigation, synchronous save cleanup, and safe user-edit cleanup.

- [ ] **Step 1: Add an async pre-mutation hook inside the existing queue**

Extend the controller constructor with:

```ts
type PrepareCanonicalDocument = (key: string) => Promise<boolean>;

constructor(
  coordinator: ReviewCoordinator,
  host: ReviewHost,
  onStateChanged?: (key: string) => void,
  prepareCanonicalDocument?: PrepareCanonicalDocument,
)
```

At the start of each serialized `approveHunk`, `rejectHunk`, `approveAll`, and `rejectAll` callback, await the hook. Return without resolving state if it reports `false`. Do not move the hook outside `serializeMutation`.

- [ ] **Step 2: Remove spacers before every review mutation**

The runtime hook calls `spacers.remove(key)`. Accept `removed` or `absent`; require the live document to equal coordinator `currentText` afterward. On `unsafe`, show an error and return `false`.

- [ ] **Step 3: Translate navigation reveal lines**

Wrap `ReviewHost.reveal` so it calls `spacers.displayLine(document.key, canonicalLine)`. Selection and reveal use the display line only; coordinator navigation still uses canonical hunk positions.

- [ ] **Step 4: Suppress exact manager document events**

At the top of `handleDocumentChange`, normalize event changes once and call `displayEditFence.consume`. If it returns `true`, return immediately without invalidating the detector, coordinator, snapshots, or document debouncer.

- [ ] **Step 5: Reconcile unexpected edits before normal comparison**

If a presentation exists and an event is not manager-owned:

1. call `spacers.reconcileUnexpectedChange` with the complete event;
2. if cleanup succeeds, call `coordinator.documentEdit` with returned canonicalized text under the existing document guard;
3. synchronize review state;
4. if unsafe, clear only presentation UI, invalidate the comparison revision, and show a warning without deleting text.

Do not pass display text containing owned spacer EOLs to `coordinator.documentEdit`.

- [ ] **Step 6: Remove presentation when the cursor enters a spacer row**

Register `vscode.window.onDidChangeTextEditorSelection`. If the active selection enters a mapped removed row, mark that presentation revision as suspended, remove exact spacers, and render the non-spacer fallback without changing coordinator state. Do not immediately reinstall the same suspended revision; a later comparison revision may install a new plan. This is a proactive safety measure only—unexpected-edit reconciliation remains authoritative.

- [ ] **Step 7: Supply synchronous on-will-save cleanup edits**

In the existing listener, call `spacers.willSaveEdits(documentSnapshot)` synchronously and immediately pass a resolved edit array:

```ts
const edits = spacers.willSaveEdits(snapshot).map((edit) => vscode.TextEdit.delete(
  new vscode.Range(
    document.positionAt(edit.offset),
    document.positionAt(edit.offset + edit.length),
  ),
));
event.waitUntil(Promise.resolve(edits));
```

Arm the display fence for the exact aggregate save edit before returning from the event listener. Preserve the existing recent-save and coordinator invalidation behavior after cleanup planning.

- [ ] **Step 8: Order clear/close/disable/dispose cleanup**

Add `ExtensionRuntime.shutdown(): Promise<void>` that marks the runtime as shutting down, invalidates future installs, awaits `spacers.clearAll()`, and only then disposes coordinator/editor resources. Add a serialized async configuration-refresh tail to `ExtensionController` so disabling or recreating the runtime awaits `shutdown()` before dropping it. Export `deactivate(): Promise<void>` and await controller shutdown. Keep synchronous `dispose()` as an idempotent emergency fallback that starts best-effort cleanup, clears decorations, and logs any presentation that cannot be safely removed; never replace cached text during shutdown.

- [ ] **Step 9: Compile and audit canonical boundaries**

```bash
npm run compile
rg -n "coordinator\.documentEdit|approveHunk|rejectHunk|onWillSaveTextDocument|waitUntil" src/extension.ts src/reviewController.ts
git diff --check -- src/extension.ts src/reviewController.ts
```

Expected: compile exit `0`; every mutation strips spacers inside the serialized queue; every `documentEdit` receives canonicalized text; `waitUntil` is called synchronously.

- [ ] **Step 10: Commit runtime integration**

```bash
git add src/extension.ts src/reviewController.ts src/documentChangeFence.ts
git commit -m "feat: keep spacer rows out of source mutations"
```

---

### Task 6: Documentation, Stable Build, and Package Verification

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-08-24-temporary-deleted-line-spacers-design.md` only if implementation reveals a resolved discrepancy.

**Interfaces:**
- Consumes: completed spacer lifecycle.
- Produces: recipient-facing behavior documentation and `codex-extension-helper-0.0.1-stable.vsix`.

- [ ] **Step 1: Document the Stable workaround and save semantics**

Add concise README text stating:

- deleted content occupies temporary real blank editor rows;
- rows are removed before Approve, Reject, and save;
- saving accepts canonical current source and clears review;
- a hard extension-host failure is an inherent risk of real-buffer spacer mode;
- Git-clean reset/checkout/restore changes do not create Codex review UI.

Add the same feature summary and risk note to `CHANGELOG.md`.

- [ ] **Step 2: Confirm no proposed API dependency**

```bash
rg -n "editorInsets|enabledApiProposals|createWebviewTextEditorInset" src package.json README.md CHANGELOG.md
```

Expected: no matches.

- [ ] **Step 3: Compile without running automated tests**

```bash
npm run compile
git diff --check
```

Expected: both commands exit `0`. Do not run `npm run check`, `npm run test:unit`, or `npm run test:extension` because the user explicitly requested no tests.

- [ ] **Step 4: Package directly without the test-running package script**

```bash
npx vsce package --no-dependencies
mv -f codex-extension-helper-0.0.1.vsix codex-extension-helper-0.0.1-stable.vsix
unzip -t codex-extension-helper-0.0.1-stable.vsix
shasum -a 256 codex-extension-helper-0.0.1-stable.vsix
```

Expected: eight archive entries, no compressed-data errors, and a new SHA-256 digest.

- [ ] **Step 5: Review final source and working tree**

```bash
git status --short --untracked-files=all
git diff --stat HEAD~6..HEAD
```

Confirm only the approved spacer implementation, earlier requested review UI/Git guard changes, documentation, and generated ignored VSIX are present.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md CHANGELOG.md docs/superpowers/specs/2026-08-24-temporary-deleted-line-spacers-design.md
git commit -m "docs: describe temporary deleted line spacers"
```
