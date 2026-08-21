# Codex Extension Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal VS Code Insiders extension that automatically renders external file changes inside the normal editable editor, with deleted lines in red read-only insets and current added/modified lines in green.

**Architecture:** A filesystem detector feeds a per-URI coordinator. The coordinator owns accepted snapshots, computes deterministic line hunks through an isolated diff engine, rejects stale work, and asks a renderer to create proposed editor insets plus normal decorations. All VS Code objects stay at the edges so core behavior is unit-testable.

**Tech Stack:** TypeScript, VS Code Insiders 1.134+, proposed `editorInsets` API, `diff`, `minimatch`, Vitest, `@vscode/test-electron`, and `@vscode/vsce`.

**Spec:** `docs/superpowers/specs/2026-08-21-codex-extension-helper-design.md`

## Global Constraints

- Never edit, revert, save, or stage the user's document; rendering is visual-only.
- Treat every qualifying external filesystem write as an agent change because VS Code cannot identify the writer.
- A user save clears comparison UI and establishes the new baseline.
- Keep proposed-API usage inside `InlineRenderer`; core modules must not depend on editor inset objects.
- Run the focused test after each implementation step and the full suite before every task commit.
- Do not commit generated `node_modules`, `out`, coverage, `.vsix`, or `.DS_Store` files.

---

## Task 1: Scaffold the extension and verification harness

**Files:**

- Create: `.gitignore`
- Create: `.vscodeignore`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/vscode.proposed.editorInsets.d.ts`
- Create: `src/extension.ts`
- Create: `test/unit/manifest.test.ts`

**Interfaces produced:** The extension manifest, build scripts, test scripts, and proposed `editorInsets` declaration used by later tasks.

- [ ] **Step 1: Write the failing manifest test**

```ts
// test/unit/manifest.test.ts
import { describe, expect, it } from 'vitest';
import manifest from '../../package.json';

describe('extension manifest', () => {
  it('targets Insiders and enables only the required proposal', () => {
    expect(manifest.engines.vscode).toBe('^1.134.0');
    expect(manifest.enabledApiProposals).toEqual(['editorInsets']);
    expect(manifest.activationEvents).toContain('onStartupFinished');
  });

  it('declares the documented defaults', () => {
    const properties = manifest.contributes.configuration.properties;
    expect(properties['codexExtensionHelper.enabled'].default).toBe(true);
    expect(properties['codexExtensionHelper.debounceMs'].default).toBe(300);
    expect(properties['codexExtensionHelper.maxFileSizeKb'].default).toBe(1024);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run test/unit/manifest.test.ts`

Expected: FAIL because `package.json`, Vitest, and TypeScript configuration do not exist yet.

- [ ] **Step 3: Add the manifest and toolchain**

Create `package.json` with extension id `codex-extension-helper`, publisher `local`, `main: ./out/extension.js`, `activationEvents: ["onStartupFinished"]`, and `enabledApiProposals: ["editorInsets"]`. Add these scripts:

```json
{
  "scripts": {
    "compile": "tsc -p .",
    "watch": "tsc -watch -p .",
    "test": "vitest",
    "test:unit": "vitest run test/unit",
    "test:extension": "npm run compile && node ./out/test/extension/runTest.js",
    "check": "npm run compile && npm run test:unit",
    "package": "npm run check && vsce package --no-dependencies"
  }
}
```

Runtime dependencies: `diff` and `minimatch`. Development dependencies: `@types/diff`, `@types/node`, `@types/vscode`, `@vscode/test-electron`, `@vscode/vsce`, `typescript`, and `vitest`. Configure `resolveJsonModule`, `strict`, `commonjs`, `ES2022`, `outDir: out`, and include `src/**/*.ts` plus `test/**/*.ts`.

Add configuration contributions for:

```json
{
  "codexExtensionHelper.enabled": true,
  "codexExtensionHelper.debounceMs": 300,
  "codexExtensionHelper.maxFileSizeKb": 1024,
  "codexExtensionHelper.exclude": [
    "**/.git/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**"
  ]
}
```

Copy the official `WebviewEditorInset` and `window.createWebviewTextEditorInset` declarations into `src/vscode.proposed.editorInsets.d.ts`, preserving the VS Code license header and module augmentation shape. Add a no-op `activate(context)` and `deactivate()` so compilation has an entry point.

- [ ] **Step 4: Install dependencies and verify the scaffold**

Run: `npm install`

Run: `npm test -- --run test/unit/manifest.test.ts`

Expected: PASS, 2 tests.

Run: `npm run compile`

Expected: PASS with JavaScript emitted under `out/`.

- [ ] **Step 5: Commit the scaffold**

```bash
git add .gitignore .vscodeignore package.json package-lock.json tsconfig.json vitest.config.ts src test/unit/manifest.test.ts
git commit -m "build: scaffold VS Code Insiders extension"
```

---

## Task 2: Implement deterministic line-oriented diffs

**Files:**

- Create: `src/types.ts`
- Create: `src/diffEngine.ts`
- Create: `test/unit/diffEngine.test.ts`

**Interfaces produced:**

```ts
export type ChangeKind = 'addition' | 'deletion' | 'modification';

export interface ChangeHunk {
  kind: ChangeKind;
  originalStart: number;
  originalEnd: number;
  modifiedStart: number;
  modifiedEnd: number;
  originalLines: readonly string[];
  modifiedLines: readonly string[];
}

export interface DiffEngine {
  compute(original: string, modified: string): readonly ChangeHunk[];
}
```

Line coordinates are zero-based and end-exclusive. For an insertion, `originalStart === originalEnd`; for a deletion, `modifiedStart === modifiedEnd`.

- [ ] **Step 1: Write failing behavior tests**

Cover pure addition, pure deletion, adjacent removal/addition folded into modification, first-line change, final-line deletion, empty files, missing final newline, unchanged input, and CRLF/LF equivalence.

```ts
it('folds adjacent removed and added blocks into one modification', () => {
  expect(engine.compute('a\nold\nz\n', 'a\nnew\nz\n')).toEqual([{
    kind: 'modification',
    originalStart: 1,
    originalEnd: 2,
    modifiedStart: 1,
    modifiedEnd: 2,
    originalLines: ['old'],
    modifiedLines: ['new'],
  }]);
});

it('normalizes line endings without creating a hunk', () => {
  expect(engine.compute('a\r\nb\r\n', 'a\nb\n')).toEqual([]);
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `npm test -- --run test/unit/diffEngine.test.ts`

Expected: FAIL because `LineDiffEngine` is not implemented.

- [ ] **Step 3: Implement `LineDiffEngine`**

Use `diffLines(original, modified, { newlineIsToken: false, ignoreNewlineAtEof: false })`. Normalize `\r\n` to `\n` before diffing, preserve whether a final empty line exists, advance independent original/modified line cursors, and merge a directly adjacent removed block plus added block into a modification. Export:

```ts
export class LineDiffEngine implements DiffEngine {
  compute(original: string, modified: string): readonly ChangeHunk[];
}
```

Do not expose `diff` package types outside this file.

- [ ] **Step 4: Verify edge cases and types**

Run: `npm test -- --run test/unit/diffEngine.test.ts`

Expected: PASS for every listed case.

Run: `npm run compile`

Expected: PASS with no implicit `any` or coordinate-type errors.

- [ ] **Step 5: Commit the diff engine**

```bash
git add src/types.ts src/diffEngine.ts test/unit/diffEngine.test.ts
git commit -m "feat: compute line-oriented change hunks"
```

---

## Task 3: Add eligibility, snapshots, debounce, and save suppression

**Files:**

- Create: `src/eligibility.ts`
- Create: `src/snapshotStore.ts`
- Create: `src/changePolicy.ts`
- Create: `test/unit/eligibility.test.ts`
- Create: `test/unit/snapshotStore.test.ts`
- Create: `test/unit/changePolicy.test.ts`

**Interfaces produced:**

```ts
export interface ExtensionSettings {
  enabled: boolean;
  debounceMs: number;
  maxFileSizeBytes: number;
  exclude: readonly string[];
}

export interface FileComparisonState {
  baselineText: string;
  currentText: string;
  hunks: readonly ChangeHunk[];
  sourceRevision: number;
  pending: boolean;
}

export class SnapshotStore {
  get(key: string): FileComparisonState | undefined;
  seed(key: string, text: string): void;
  setComparison(key: string, state: FileComparisonState): void;
  accept(key: string, text: string): void;
  delete(key: string): void;
  clear(): void;
}
```

- [ ] **Step 1: Write failing pure unit tests**

Test non-file schemes, excluded paths, NUL bytes, and size limits. Test independent URI state, comparison persistence, save/accept resetting hunks, delete, and clear. With a fake clock, test that `RecentSaveRegistry.consume(uri, now)` suppresses one watcher event within its window but not later events. With fake timers, test that `PerKeyDebouncer` collapses events for one URI while keeping two URIs independent.

- [ ] **Step 2: Confirm the tests fail**

Run: `npm test -- --run test/unit/eligibility.test.ts test/unit/snapshotStore.test.ts test/unit/changePolicy.test.ts`

Expected: FAIL because the policy modules do not exist.

- [ ] **Step 3: Implement the pure policy modules**

Use `minimatch(relativePath, pattern, { dot: true })`. Detect binary content by a NUL character in the decoded text. Clamp `debounceMs` to `50..5000` and the maximum size to a positive integer. Implement save suppression as a one-shot URI timestamp with a 2-second default window.

`PerKeyDebouncer<K>` must expose `schedule(key, delayMs, callback)`, `cancel(key)`, and `dispose()`. Scheduling the same key replaces its timer; exceptions remain owned by the callback's caller.

- [ ] **Step 4: Run policy tests and the full unit suite**

Run: `npm test -- --run test/unit/eligibility.test.ts test/unit/snapshotStore.test.ts test/unit/changePolicy.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit state and policy primitives**

```bash
git add src/eligibility.ts src/snapshotStore.ts src/changePolicy.ts test/unit
git commit -m "feat: track snapshots and external change policy"
```

---

## Task 4: Coordinate external changes and reject stale work

**Files:**

- Create: `src/coordinator.ts`
- Create: `test/unit/coordinator.test.ts`

**Interfaces consumed:** `DiffEngine`, `SnapshotStore`, `ChangeHunk`, `PerKeyDebouncer`.

**Interfaces produced:**

```ts
export interface ComparisonView {
  render(key: string, hunks: readonly ChangeHunk[]): Promise<void>;
  clear(key: string): void;
  clearAll(): void;
}

export class ComparisonCoordinator {
  seed(key: string, text: string): void;
  externalChange(key: string, text: string): Promise<void>;
  documentEdit(key: string, text: string): Promise<void>;
  save(key: string, text: string): void;
  delete(key: string): void;
  show(key: string): Promise<void>;
  dispose(): void;
}
```

- [ ] **Step 1: Write failing lifecycle and race tests**

Use fake `DiffEngine` and `ComparisonView` objects. Verify:

- the first unseen external content seeds a baseline and renders nothing;
- a later external write diffs against the accepted baseline;
- invisible comparisons remain pending and render on `show`;
- document edits recompute against the original baseline;
- save clears UI and accepts current text;
- delete clears state and UI;
- resolving an older deferred diff after a newer one never renders stale hunks;
- dispose cancels pending work and clears all rendering.

```ts
it('lets a newer revision win', async () => {
  const first = deferred<readonly ChangeHunk[]>();
  engine.queue(first.promise, Promise.resolve(newerHunks));
  const oldRun = coordinator.externalChange(key, 'old-result');
  await coordinator.externalChange(key, 'new-result');
  first.resolve(olderHunks);
  await oldRun;
  expect(view.render).toHaveBeenLastCalledWith(key, newerHunks);
});
```

- [ ] **Step 2: Confirm the coordinator tests fail**

Run: `npm test -- --run test/unit/coordinator.test.ts`

Expected: FAIL because `ComparisonCoordinator` does not exist.

- [ ] **Step 3: Implement revision-based serialization**

Increment a per-URI revision before each async diff. Capture the revision and modified text; apply only if both still match current state when computation resolves. Store hunks even when no visible view is present. Keep the renderer abstract: the VS Code adapter decides whether `render` has an editor to target.

On `save`, synchronously increment the revision, replace the baseline, empty hunks, clear pending state, and call `view.clear(key)`. On `dispose`, mark the coordinator disposed before clearing all state.

- [ ] **Step 4: Verify races and full unit behavior**

Run: `npm test -- --run test/unit/coordinator.test.ts`

Expected: PASS, including the deferred stale-result test.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit the coordinator**

```bash
git add src/coordinator.ts test/unit/coordinator.test.ts
git commit -m "feat: coordinate comparison lifecycle and races"
```

---

## Task 5: Render red insets and green current lines

**Files:**

- Create: `src/inlineRenderer.ts`
- Create: `test/unit/inlineRenderer.test.ts`

**Interfaces consumed:** `ComparisonView`, `ChangeHunk`, proposed `WebviewEditorInset`.

- [ ] **Step 1: Write failing renderer-helper tests**

Test HTML escaping for `& < > " '`, tab preservation, no script tag, a nonce-free strict CSP, line number labels, and anchor calculation for first-line changes, pure deletions before a surviving line, and EOF deletions.

```ts
it('escapes document text before inserting it into a webview', () => {
  const html = buildDeletedLinesHtml(['<script>alert(1)</script>', 'a & b'], 4);
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).toContain('a &amp; b');
});
```

- [ ] **Step 2: Confirm the renderer tests fail**

Run: `npm test -- --run test/unit/inlineRenderer.test.ts`

Expected: FAIL because HTML and anchor helpers are absent.

- [ ] **Step 3: Implement renderer helpers and `InlineRenderer`**

Export pure `escapeHtml`, `buildDeletedLinesHtml`, and `insetPlacementForHunk` helpers for tests. The Webview HTML must include:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
```

Use `white-space: pre`, `tab-size: var(--vscode-editor-tabSize, 4)`, `--vscode-diffEditor-removedTextBackground`, editor foreground/font variables, and a red gutter. No scripts, commands, links, or message handlers.

Create one green `TextEditorDecorationType` using `isWholeLine: true`, `rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed`, `--vscode-diffEditor-insertedTextBackground`-compatible theme colors, and overview-ruler markers. Apply it to added/modified modified ranges only.

For original lines in deletion/modification hunks, call `window.createWebviewTextEditorInset(editor, anchorLine, originalLines.length, { enableScripts: false })`. Dispose old insets before a rerender. Maintain view resources by normalized URI and editor instance so split groups do not overwrite each other.

If `createWebviewTextEditorInset` is missing or throws, log the error, show one actionable warning, disable future rendering for the session, and leave all documents untouched.

- [ ] **Step 4: Verify helper safety and compilation**

Run: `npm test -- --run test/unit/inlineRenderer.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS with proposed API types resolved.

- [ ] **Step 5: Commit the inline renderer**

```bash
git add src/inlineRenderer.ts test/unit/inlineRenderer.test.ts
git commit -m "feat: render external edits inline"
```

---

## Task 6: Connect VS Code filesystem and editor events

**Files:**

- Create: `src/externalChangeDetector.ts`
- Modify: `src/extension.ts`
- Create: `test/unit/externalChangeDetector.test.ts`
- Create: `test/extension/runTest.ts`
- Create: `test/extension/suite/index.ts`
- Create: `test/extension/suite/extension.test.ts`

**Interfaces consumed:** eligibility policy, recent-save registry, debouncer, coordinator, and renderer.

- [ ] **Step 1: Write failing detector tests with injected adapters**

Inject `readFile`, `settings`, `onComparison`, and `onError` functions. Verify per-URI debounce, recent-save suppression, excluded/oversized/binary files, missing-baseline seeding, delete cleanup, and independent file processing. Use fake timers; do not touch the real filesystem in unit tests.

- [ ] **Step 2: Confirm detector tests fail**

Run: `npm test -- --run test/unit/externalChangeDetector.test.ts`

Expected: FAIL because `ExternalChangeDetector` is absent.

- [ ] **Step 3: Implement `ExternalChangeDetector`**

Create a `workspace.createFileSystemWatcher('**/*')` adapter. For create/change events: normalize the URI, suppress a recent save once, debounce, read bytes through `workspace.fs.readFile`, enforce the byte limit before decoding, decode UTF-8, reject NUL-containing text, and forward usable content. For delete: cancel the URI timer and clear coordinator state. Route errors to the output channel without throwing into VS Code's event loop.

- [ ] **Step 4: Wire activation and lifecycle events**

In `activate`:

1. Create `OutputChannel('Codex Extension Helper')`.
2. Read and validate configuration.
3. Build `LineDiffEngine`, `SnapshotStore`, `InlineRenderer`, `ComparisonCoordinator`, and `ExternalChangeDetector`.
4. Seed snapshots for currently open file documents.
5. Subscribe to `onDidOpenTextDocument`, `onDidChangeTextDocument`, `onWillSaveTextDocument`, `onDidSaveTextDocument`, `onDidCloseTextDocument`, `onDidChangeVisibleTextEditors`, `onDidChangeWorkspaceFolders`, and `onDidChangeConfiguration`.
6. Ignore user edits unless a comparison is active; while active, debounce recomputation from the accepted baseline.
7. On save, mark the URI in `RecentSaveRegistry`, clear its UI, and accept the saved text.
8. On close, dispose editor-specific UI but retain pending comparison state.
9. On disable or deactivate, dispose watcher, timers, insets, decorations, subscriptions, output channel, and memory state.

Configuration changes should rebuild the watcher only when enabled/exclude-related behavior changes; disabling must immediately clear everything.

- [ ] **Step 5: Add an Insiders Extension Host smoke test**

The test opens a temporary workspace file, activates the extension, performs an external `workspace.fs.writeFile`, waits for the configured debounce, and asserts via an exported test-only diagnostics object that a comparison was stored and rendered. Then save and assert the comparison count returns to zero. Skip with a clear message when the host does not expose `createWebviewTextEditorInset`; the manual launch remains the definitive inset check.

- [ ] **Step 6: Run unit and host verification**

Run: `npm run check`

Expected: PASS.

Run: `npm run test:extension`

Expected: VS Code Insiders launches; smoke test passes, or only the explicit proposed-API skip is reported when run under an incompatible host.

- [ ] **Step 7: Commit activation and integration**

```bash
git add src test/unit/externalChangeDetector.test.ts test/extension
git commit -m "feat: detect external writes and manage editor lifecycle"
```

---

## Task 7: Document, package, and manually verify the personal VSIX

**Files:**

- Create: `.vscode/launch.json`
- Create: `.vscode/tasks.json`
- Create: `README.md`
- Create: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Add the Insiders development launch configuration**

Configure an extension-host launch that uses `${workspaceFolder}` as the extension development path and passes:

```json
[
  "--enable-proposed-api=local.codex-extension-helper",
  "${workspaceFolder}/test-fixtures/workspace"
]
```

Add a default build task running `npm run watch`.

- [ ] **Step 2: Write user-facing setup and limitations**

README must explain:

- this extension displays all qualifying external writes, not Codex identity;
- VS Code Insiders is required;
- install commands for the generated VSIX;
- the `--enable-proposed-api=local.codex-extension-helper` launch requirement;
- red blocks are read-only history, green lines are current editable content;
- saving clears the comparison;
- settings and defaults;
- no Accept/Reject, persistence across restarts, stable VS Code, or Marketplace support;
- troubleshooting through the `Codex Extension Helper` output channel.

- [ ] **Step 3: Run automated verification**

Run: `npm run check`

Expected: PASS.

Run: `npm run test:extension`

Expected: PASS or the single documented incompatible-host skip.

- [ ] **Step 4: Package the VSIX and inspect its contents**

Run: `npm run package`

Expected: a `codex-extension-helper-<version>.vsix` file is created.

Run: `npx vsce ls`

Expected: package contains compiled `out/` code, README, changelog, license/manifest files, and excludes source tests, coverage, `.git`, and `node_modules`.

- [ ] **Step 5: Perform the manual acceptance matrix in VS Code Insiders**

Verify all of the following before claiming completion:

- external addition, deletion, and replacement appear without clicking anything;
- red deleted blocks and green current lines align at file start, middle, and EOF;
- saving immediately clears both kinds of UI;
- an externally changed background file renders when opened;
- typing during an active comparison realigns it against the original baseline;
- two editor groups and multiple files keep independent UI;
- light/dark themes, tabs, long lines, Unicode, and `<>&` text remain readable and safe;
- excluded, binary, oversized, and non-file documents render nothing;
- rapid atomic writes settle to the newest file content;
- disabling the setting and deactivation leave no insets or decorations;
- launching without proposed API support produces one warning and never changes a file.

- [ ] **Step 6: Record the release and commit**

Add the initial version and verified limitations to `CHANGELOG.md`, then run:

```bash
git add .vscode README.md CHANGELOG.md package.json package-lock.json
git commit -m "docs: add Insiders setup and VSIX packaging"
git status --short
```

Expected: clean worktree except for the intentionally untracked generated `.vsix`, which is ignored by `.gitignore`.

---

## Final Verification Gate

- [ ] Run `npm run check` and confirm zero errors.
- [ ] Run `npm run test:extension` under VS Code Insiders with the proposal enabled.
- [ ] Run `npm run package` and install the resulting VSIX into a clean Insiders profile.
- [ ] Repeat the manual addition/replacement/deletion/save flow on a real file.
- [ ] Run `git log --oneline --decorate -8` and confirm each task has a focused commit.
- [ ] Run `git status --short` and confirm no unintended files remain.
