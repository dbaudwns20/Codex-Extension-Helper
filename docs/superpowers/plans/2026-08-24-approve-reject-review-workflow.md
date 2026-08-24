# Approve/Reject Review Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing VS Code Stable inline change display into an active-file review workflow where Approve keeps already-written changes, Reject restores the latest review baseline, and editor-title controls navigate or resolve all remaining hunks.

**Architecture:** Keep line decoration and CodeLens rendering at the VS Code boundary, move line-preserving patch calculations into pure helpers, and make `ComparisonCoordinator` the authority for revision-guarded baseline transitions. A `ReviewController` validates the live active document, delegates approval state changes, performs guarded `WorkspaceEdit` or trash deletion for rejection, navigates hunks, and asks the runtime to resynchronize Quick Diff, CodeLens, decorations, and the active-file context key.

**Tech Stack:** TypeScript, VS Code Stable `^1.105.0`, stable CodeLens/commands/editor-title menu/WorkspaceEdit/filesystem APIs, existing `diff` engine, Vitest, `@vscode/test-electron`, and `@vscode/vsce`.

**Spec:** `docs/superpowers/specs/2026-08-24-approve-reject-review-workflow-design.md`

## Global Constraints

- Treat the real workspace document as already modified: Approve changes comparison state only; Reject is the only review action that edits or deletes workspace content.
- Never invoke `TextDocument.save`, write approved content through `workspace.fs`, or stage Git changes.
- All-file commands affect only the active file.
- Keep all APIs compatible with VS Code Stable; do not reintroduce `editorInsets` or any proposed API.
- Validate file key, source revision, hunk index, and exact live document text before every hunk action.
- Use zero-based, end-exclusive hunk coordinates and preserve the source text's EOL and final-newline shape.
- On edit or deletion failure, retain comparison state and UI, log details, and show a concise error.
- Run the focused test after each implementation step and the complete verification suite before packaging.
- Preserve unrelated working-tree changes; stage only files owned by the current task if commits are made.

---

## Task 1: Add line-preserving review text helpers

**Files:**

- Create: `src/reviewText.ts`
- Create: `test/unit/reviewText.test.ts`

**Interfaces produced:**

```ts
export interface TextReplacement {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly replacementText: string;
}

export function applyApprovedHunk(
  baselineText: string,
  hunk: ChangeHunk,
): string;

export function rejectedHunkReplacement(
  currentText: string,
  hunk: ChangeHunk,
): TextReplacement;
```

`TextReplacement.startOffset` and `endOffset` are UTF-16 character offsets compatible with `TextDocument.positionAt`, with the end offset exclusive. `replacementText` is ready for a VS Code range replacement and uses the detected EOL of the supplied text.

- [ ] **Step 1: Write failing tests for baseline approval patching**

Cover addition, deletion, modification, first-line and EOF hunks, LF, CRLF, empty text, a blank final line, and a file without a final newline. Include assertions such as:

```ts
it('approves a modification without changing CRLF or final newline', () => {
  const hunk: ChangeHunk = {
    kind: 'modification',
    originalStart: 1,
    originalEnd: 2,
    modifiedStart: 1,
    modifiedEnd: 2,
    originalLines: ['old'],
    modifiedLines: ['new'],
  };

  expect(applyApprovedHunk('a\r\nold\r\nz\r\n', hunk))
    .toBe('a\r\nnew\r\nz\r\n');
});
```

- [ ] **Step 2: Write failing tests for rejection edit plans**

Assert that addition deletes `modifiedStart..modifiedEnd`, deletion inserts `originalLines` at `modifiedStart`, and modification replaces the modified range. Verify LF and CRLF replacement strings and EOF behavior.

```ts
expect(rejectedHunkReplacement('a\nnew\nz\n', hunk)).toEqual({
  startOffset: 2,
  endOffset: 6,
  replacementText: 'old\n',
});
```

- [ ] **Step 3: Run the focused test and confirm failure**

Run: `npm test -- --run test/unit/reviewText.test.ts`

Expected: FAIL because `src/reviewText.ts` does not exist.

- [ ] **Step 4: Implement offset-aware patching**

Implement a private line table that records each logical line's content start, content end, and terminator end. Detect the first newline sequence (`\r\n` or `\n`) and use LF only when the text contains no newline. Convert hunk line coordinates to character offsets without normalizing the whole file. Return those offsets for rejection edits and apply approvals with:

```ts
return baselineText.slice(0, startOffset)
  + encodeReplacement(hunk.modifiedLines, location, eol)
  + baselineText.slice(endOffset);
```

The encoding helper must decide whether a trailing EOL belongs to the replaced range from the original line table, so replacing an interior line keeps its separator while an EOF line without a separator stays unterminated.

- [ ] **Step 5: Verify the helper**

Run: `npm test -- --run test/unit/reviewText.test.ts`

Expected: PASS for every hunk kind, EOL style, and final-newline case.

Run: `npm run compile`

Expected: PASS with no VS Code dependency in `reviewText.ts`.

- [ ] **Step 6: Commit the text helper**

```bash
git add src/reviewText.ts test/unit/reviewText.test.ts
git commit -m "feat: add review text patch helpers"
```

---

## Task 2: Make comparison state revision-safe and created-file aware

**Files:**

- Modify: `src/types.ts`
- Modify: `src/snapshotStore.ts`
- Modify: `src/coordinator.ts`
- Modify: `test/unit/snapshotStore.test.ts`
- Modify: `test/unit/coordinator.test.ts`

**Interfaces consumed:** `ChangeHunk`, `applyApprovedHunk`, existing diff engine and comparison view.

**Interfaces produced:**

```ts
export interface HunkReference {
  readonly key: string;
  readonly sourceRevision: number;
  readonly hunkIndex: number;
  readonly expectedText: string;
}

export type ReviewStateResult =
  | { readonly status: 'ok'; readonly state: FileComparisonState }
  | { readonly status: 'missing' | 'stale' };

export interface FileComparisonState {
  baselineText: string;
  currentText: string;
  hunks: readonly ChangeHunk[];
  sourceRevision: number;
  comparisonActive: boolean;
  pending: boolean;
  createdFile: boolean;
}
```

Add coordinator methods:

```ts
state(key: string): FileComparisonState | undefined;
resolveHunk(reference: HunkReference):
  | { status: 'ok'; state: FileComparisonState; hunk: ChangeHunk }
  | { status: 'missing' | 'stale' };
approveHunk(reference: HunkReference): Promise<'approved' | 'missing' | 'stale'>;
approveAll(key: string, expectedText: string): 'approved' | 'missing' | 'stale';
```

- [ ] **Step 1: Extend snapshot tests first**

Assert normal seed/save/accept states set `createdFile: false`, explicitly created comparison state retains `createdFile: true`, and accepted-state transitions clear hunks and lifecycle flags.

- [ ] **Step 2: Add failing coordinator tests**

Test that `externalCreate` compares from an empty baseline and marks the state created; `approveHunk` patches only the selected baseline section and recomputes remaining hunks; the final approval clears the view and comparison lifecycle; `approveAll` uses exact current text without a write callback. Test missing keys, revision mismatch, index overflow, and `expectedText` mismatch.

```ts
expect(coordinator.resolveHunk({
  key,
  sourceRevision: state.sourceRevision - 1,
  hunkIndex: 0,
  expectedText: state.currentText,
})).toEqual({ status: 'stale' });
```

- [ ] **Step 3: Confirm focused failures**

Run: `npm test -- --run test/unit/snapshotStore.test.ts test/unit/coordinator.test.ts`

Expected: FAIL because `createdFile`, hunk references, and approval transitions are absent.

- [ ] **Step 4: Implement state defaults and guarded resolution**

Set `createdFile: false` in `seed`, `save`, and accepted states. Make `externalCreate` create a comparison whose baseline is empty and `createdFile` is true without passing through a normal seed that loses origin metadata. `resolveHunk` must return stale unless all of these match the current state:

```ts
state.sourceRevision === reference.sourceRevision
  && state.currentText === reference.expectedText
  && reference.hunkIndex >= 0
  && reference.hunkIndex < state.hunks.length
```

- [ ] **Step 5: Implement approvals through one comparison path**

For one hunk, calculate a patched baseline using `applyApprovedHunk`, advance the revision before awaiting the diff, and recompute against the unchanged `currentText`. For Approve All, install an accepted state whose baseline/current text are `expectedText`, advance the revision, and clear the view. Preserve `createdFile` only while unresolved hunks remain.

- [ ] **Step 6: Verify coordinator behavior**

Run: `npm test -- --run test/unit/snapshotStore.test.ts test/unit/coordinator.test.ts`

Expected: PASS, including partial approval, final approval, created-file state, and all stale cases.

Run: `npm run compile`

Expected: PASS.

- [ ] **Step 7: Commit comparison transitions**

```bash
git add src/types.ts src/snapshotStore.ts src/coordinator.ts test/unit/snapshotStore.test.ts test/unit/coordinator.test.ts
git commit -m "feat: add guarded approval state transitions"
```

---

## Task 3: Expand CodeLens into per-hunk review actions

**Files:**

- Modify: `src/deletedLinesCodeLensProvider.ts`
- Modify: `test/unit/deletedLinesCodeLensProvider.test.ts`

**Interfaces consumed:** `ChangeHunk`, `HunkReference`, latest source revision/current text from the runtime.

**Interfaces produced:** `codexExtensionHelper.approveHunk` and `codexExtensionHelper.rejectHunk` command arguments for every hunk.

Change the provider update shape to:

```ts
export interface ReviewCodeLensState {
  readonly key: string;
  readonly sourceRevision: number;
  readonly currentText: string;
  readonly hunks: readonly ChangeHunk[];
}

update(state: ReviewCodeLensState): void;
```

- [ ] **Step 1: Write failing CodeLens tests**

For an addition-only hunk expect exactly Approve and Reject lenses. For a deletion/modification expect a deleted-content summary followed by Approve and Reject at the same anchor. Assert both action arguments contain the same immutable reference:

```ts
expect(lenses.map((lens) => lens.command?.command)).toEqual([
  'codexExtensionHelper.approveHunk',
  'codexExtensionHelper.rejectHunk',
]);
expect(lenses[0].command?.arguments).toEqual([{
  key,
  sourceRevision: 7,
  hunkIndex: 0,
  expectedText: 'new\n',
}]);
```

Retain preview truncation, blank-line labeling, multiline summary, clear, and dispose coverage.

- [ ] **Step 2: Confirm failure**

Run: `npm test -- --run test/unit/deletedLinesCodeLensProvider.test.ts`

Expected: FAIL because the provider filters addition-only hunks and emits only Open Diff.

- [ ] **Step 3: Store full review descriptors and emit ordered lenses**

Store all hunks per URI key. Derive the action reference from the state and array index. Use titles `$(check) Approve` and `$(close) Reject`; keep the summary non-mutating and route it to `codexExtensionHelper.openDiff`. Anchor a deletion at `modifiedStart`, clamped to the document's final valid line.

- [ ] **Step 4: Verify CodeLens behavior**

Run: `npm test -- --run test/unit/deletedLinesCodeLensProvider.test.ts`

Expected: PASS for addition, deletion, modification, ordering, arguments, clearing, and disposal.

Run: `npm run compile`

Expected: PASS.

- [ ] **Step 5: Commit CodeLens actions**

```bash
git add src/deletedLinesCodeLensProvider.ts test/unit/deletedLinesCodeLensProvider.test.ts
git commit -m "feat: show approve and reject hunk actions"
```

---

## Task 4: Add pure navigation and active-file review helpers

**Files:**

- Create: `src/reviewNavigation.ts`
- Create: `test/unit/reviewNavigation.test.ts`

**Interfaces consumed:** ordered `ChangeHunk` arrays and active cursor line.

**Interfaces produced:**

```ts
export type ReviewDirection = 'previous' | 'next';

export function reviewAnchor(hunk: ChangeHunk): number;

export function targetReviewIndex(
  hunks: readonly ChangeHunk[],
  cursorLine: number,
  direction: ReviewDirection,
): number | undefined;
```

- [ ] **Step 1: Write failing navigation tests**

Cover no hunks, cursor before/between/after hunks, exact hunk anchor, deletion anchors, and wraparound in both directions. Exact-anchor Next must move to the following hunk; exact-anchor Previous must move to the preceding hunk.

- [ ] **Step 2: Confirm failure**

Run: `npm test -- --run test/unit/reviewNavigation.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement deterministic navigation**

Use `modifiedStart` as the anchor. For Next choose the first anchor strictly greater than the cursor, otherwise index 0. For Previous choose the last anchor strictly less than the cursor, otherwise the final index.

- [ ] **Step 4: Verify navigation**

Run: `npm test -- --run test/unit/reviewNavigation.test.ts`

Expected: PASS, including wraparound.

Run: `npm run compile`

Expected: PASS.

- [ ] **Step 5: Commit navigation helper**

```bash
git add src/reviewNavigation.ts test/unit/reviewNavigation.test.ts
git commit -m "feat: add review hunk navigation"
```

---

## Task 5: Implement the VS Code review controller

**Files:**

- Create: `src/reviewController.ts`
- Create: `test/unit/reviewController.test.ts`

**Interfaces consumed:** coordinator state/resolution/approval methods, `rejectedHunkReplacement`, navigation helpers, and stable VS Code operations supplied by an adapter.

**Interfaces produced:**

```ts
export interface ReviewHost {
  activeDocument(): LiveReviewDocument | undefined;
  applyReplacement(document: LiveReviewDocument, replacement: TextReplacement): Promise<boolean>;
  replaceAll(document: LiveReviewDocument, text: string): Promise<boolean>;
  deleteToTrash(uri: vscode.Uri): Promise<void>;
  reveal(document: LiveReviewDocument, line: number): void;
  showError(message: string): void;
  log(scope: string, error: unknown): void;
}

export class ReviewController implements vscode.Disposable {
  approveHunk(reference: HunkReference): Promise<void>;
  rejectHunk(reference: HunkReference): Promise<void>;
  approveAll(uri?: vscode.Uri): Promise<void>;
  rejectAll(uri?: vscode.Uri): Promise<void>;
  previousChange(uri?: vscode.Uri): void;
  nextChange(uri?: vscode.Uri): void;
  dispose(): void;
}
```

`LiveReviewDocument` carries URI/key, exact text, document version, line count, and EOL so tests do not need a real extension host.

- [ ] **Step 1: Write failing approval controller tests**

Assert Approve one delegates the exact hunk reference and performs no host edit/save/write; Approve All affects only the active key and performs no host mutation; missing or stale actions refresh/synchronize but do not mutate. Assert successful actions invoke an injected `onStateChanged(key)` callback.

- [ ] **Step 2: Write failing rejection controller tests**

Cover addition, deletion, and modification replacement plans; Reject All replacing the entire active document with the latest baseline; partial approval followed by Reject All using the partially accepted baseline; false `applyEdit` results; thrown errors; and exact text/version mismatch. In all failure cases state and UI must remain pending.

- [ ] **Step 3: Write failing created-file deletion tests**

Both Reject one and Reject All must call only:

```ts
await host.deleteToTrash(document.uri);
```

The VS Code adapter will implement this as `workspace.fs.delete(uri, { useTrash: true })`. Assert no empty-document edit occurs and state is cleared only after successful deletion.

- [ ] **Step 4: Write failing navigation controller tests**

Assert Previous/Next operate on the active file only, call `reveal` with the pure helper's target line, and no-op safely when there is no active pending state.

- [ ] **Step 5: Confirm controller failures**

Run: `npm test -- --run test/unit/reviewController.test.ts`

Expected: FAIL because the controller and VS Code host boundary do not exist.

- [ ] **Step 6: Implement `ReviewController`**

Resolve the active document/key, require `document.text === state.currentText`, and guard the captured version immediately before the host mutation. For existing-file Reject one, apply the planned range. For Reject All, replace the full document with `state.baselineText`. The existing `onDidChangeTextDocument` path is the only path that invalidates the old revision and recomputes remaining hunks after a successful edit; the controller must not perform a second comparison or clear state preemptively. For a created file, delete to trash and call the existing coordinator deletion lifecycle only after deletion succeeds. Catch errors, log them, show `Could not reject Codex changes.`, and retain pending state.

- [ ] **Step 7: Verify controller behavior**

Run: `npm test -- --run test/unit/reviewController.test.ts`

Expected: PASS for approvals, each rejection kind, created-file deletion, stale guards, failures, active-file scoping, and navigation.

Run: `npm run compile`

Expected: PASS using stable VS Code types only.

- [ ] **Step 8: Commit the controller**

```bash
git add src/reviewController.ts test/unit/reviewController.test.ts
git commit -m "feat: implement approve reject review controller"
```

---

## Task 6: Wire commands, title buttons, context, and synchronized views

**Files:**

- Modify: `src/extension.ts`
- Modify: `src/deletedLinesCodeLensProvider.ts`
- Modify: `src/quickDiffBridge.ts`
- Modify: `package.json`
- Modify: `test/unit/manifest.test.ts`
- Modify: `test/unit/packageRuntime.test.ts`
- Create: `test/unit/activeReviewContext.test.ts`
- Create: `src/activeReviewContext.ts`

**Interfaces consumed:** `ReviewController`, `FileComparisonState`, full CodeLens review state, existing renderer and Quick Diff bridge.

**Interfaces produced:** six review commands and `codexExtensionHelper.activeFileHasChanges`.

Command IDs:

```text
codexExtensionHelper.approveHunk
codexExtensionHelper.rejectHunk
codexExtensionHelper.previousChange
codexExtensionHelper.nextChange
codexExtensionHelper.approveAll
codexExtensionHelper.rejectAll
```

- [ ] **Step 1: Write failing manifest tests**

Assert all six commands are contributed. Assert four `editor/title` menu items use the stable context condition:

```json
"when": "resourceScheme == file && codexExtensionHelper.activeFileHasChanges"
```

Require groups/order `navigation@10`, `navigation@11`, `navigation@20`, and `navigation@21`, with icons `$(arrow-up)`, `$(arrow-down)`, `$(check-all)`, and `$(discard)` respectively. Keep per-hunk commands out of the editor title.

- [ ] **Step 2: Write failing active-context tests**

Create a small `ActiveReviewContext` with an injected `setContext(key, value)` function. Test active editor changes, inactive-file changes, pending-to-cleared transitions, file deletion, extension disable, and dispose. Repeated identical values must not issue redundant commands.

- [ ] **Step 3: Confirm failures**

Run: `npm test -- --run test/unit/manifest.test.ts test/unit/packageRuntime.test.ts test/unit/activeReviewContext.test.ts`

Expected: FAIL because commands, menu entries, and the context manager are missing.

- [ ] **Step 4: Implement the context manager**

Expose:

```ts
update(activeKey: string | undefined, state: FileComparisonState | undefined): Promise<void>;
clear(): Promise<void>;
dispose(): void;
```

Set the context true only when the active file state has at least one hunk and is pending. Runtime command handlers still validate current state independently.

- [ ] **Step 5: Register commands and the stable VS Code host adapter**

Inside `ExtensionRuntime`, instantiate `ReviewController`, register all commands through the existing disposable ownership, and implement edits with `WorkspaceEdit` plus `workspace.applyEdit`. Build ranges with `document.positionAt(replacement.startOffset)` and `document.positionAt(replacement.endOffset)` so EOF insertions and full-document replacement are valid. Implement deletion exactly as:

```ts
await vscode.workspace.fs.delete(uri, { useTrash: true });
```

Implement navigation with a collapsed `Selection`, `editor.revealRange(range, vscode.TextEditorRevealType.InCenter)`, and the active editor only.

- [ ] **Step 6: Centralize view synchronization**

Extend `syncComparison(key)` so one latest state updates all consumers together:

```ts
renderer.render/clear
deletedLines.update/clear
quickDiff.update/clear
activeReviewContext.update(activeKey, activeState)
```

Call it after external comparison, document edit, approval, successful rejection, save, delete, visible-editor change, active-editor change, settings disable, and disposal. Quick Diff must always receive the latest partially accepted `baselineText`, never the original initial baseline.

- [ ] **Step 7: Verify runtime wiring**

Run: `npm test -- --run test/unit/manifest.test.ts test/unit/packageRuntime.test.ts test/unit/activeReviewContext.test.ts test/unit/deletedLinesCodeLensProvider.test.ts`

Expected: PASS with all stable command/menu/context and view-sync assertions.

Run: `npm run compile`

Expected: PASS with no proposed API declaration or use.

- [ ] **Step 8: Commit runtime integration**

```bash
git add src/extension.ts src/deletedLinesCodeLensProvider.ts src/quickDiffBridge.ts src/activeReviewContext.ts package.json test/unit/manifest.test.ts test/unit/packageRuntime.test.ts test/unit/activeReviewContext.test.ts
git commit -m "feat: wire active file review controls"
```

---

## Task 7: Add extension-host coverage, documentation, and package the Stable build

**Files:**

- Modify: `test/extension/suite/extension.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Verify generated artifact: `codex-extension-helper-0.0.1-stable.vsix`

**Interfaces verified:** command registration, active-file Approve/Reject behavior, title visibility lifecycle, save/delete cleanup, and installable VS Code Stable package.

- [ ] **Step 1: Add extension-host tests**

Open a temporary existing file, establish a baseline, simulate an external change through the existing test seam, and invoke `codexExtensionHelper.approveHunk`; assert current document text is unchanged and comparison UI/state clears. Repeat with Reject and assert the original content is restored. Create a file comparison and assert Reject All removes it through the trash-capable adapter seam. Verify the context key becomes false after Approve All, Reject All, save, and file deletion.

- [ ] **Step 2: Run extension-host tests**

Run: `npm run test:extension`

Expected: PASS in the downloaded VS Code Stable extension host. If the environment cannot launch Electron, record the exact launcher error and continue only with unit/build verification; do not claim extension-host success.

- [ ] **Step 3: Update user documentation**

Document that Codex changes are already in the source, Approve keeps them without saving, Reject restores baseline content, created-file rejection moves the file to trash, title actions apply to the active file, arrows wrap, and the extension targets VS Code Stable. Remove any remaining Insiders/editorInsets guidance or warning text.

- [ ] **Step 4: Run the complete verification suite**

Run: `npm run check`

Expected: TypeScript compilation and every unit test PASS.

Run: `rg -n "editorInsets|enabledApiProposals|could not render deleted lines|VS Code Insiders" src package.json README.md CHANGELOG.md`

Expected: no obsolete proposed-API runtime, manifest, or user-warning references.

- [ ] **Step 5: Build the installable VSIX**

Run: `npm run package`

Expected: PASS and produce `codex-extension-helper-0.0.1.vsix`.

Rename the artifact to the established Stable filename without deleting unrelated artifacts:

```bash
mv codex-extension-helper-0.0.1.vsix codex-extension-helper-0.0.1-stable.vsix
```

Inspect contents:

Run: `unzip -l codex-extension-helper-0.0.1-stable.vsix`

Expected: compiled extension entry point, manifest, README, and changelog are present; source tests, `node_modules`, coverage, and proposed API declaration are absent.

- [ ] **Step 6: Review the final working tree and commit owned source changes**

Run: `git status --short`

Expected: only intended task files plus any pre-existing user changes; do not stage the `.vsix` if it is ignored and do not stage unrelated files.

```bash
git add README.md CHANGELOG.md test/extension/suite/extension.test.ts
git commit -m "docs: describe approve reject review workflow"
```

- [ ] **Step 7: Report the build**

Provide the absolute clickable path to `codex-extension-helper-0.0.1-stable.vsix`, summarize Approve/Reject semantics, and report the exact results of unit, compile, package, and extension-host verification separately.
