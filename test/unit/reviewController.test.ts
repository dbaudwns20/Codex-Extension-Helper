import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { ComparisonCoordinator, type ComparisonView } from '../../src/coordinator';
import { LineDiffEngine } from '../../src/diffEngine';
import {
  ReviewController,
  type LiveReviewDocument,
  type ReviewHost,
} from '../../src/reviewController';
import { SnapshotStore } from '../../src/snapshotStore';
import type { ChangeHunk, FileComparisonState, HunkReference } from '../../src/types';
import type { TextReplacement } from '../../src/reviewText';

const key = 'file:///workspace/file.ts';

class RecordingView implements ComparisonView {
  readonly cleared: string[] = [];
  readonly rendered: Array<{ key: string; hunks: readonly ChangeHunk[] }> = [];

  async render(renderedKey: string, hunks: readonly ChangeHunk[]): Promise<void> {
    this.rendered.push({ key: renderedKey, hunks });
  }

  clear(clearedKey: string): void {
    this.cleared.push(clearedKey);
  }

  clearAll(): void {}
}

type ActiveDocumentResult = LiveReviewDocument | undefined;
type QueuedActiveDocument = ActiveDocumentResult | (() => ActiveDocumentResult);

class RecordingHost implements ReviewHost {
  document: LiveReviewDocument | undefined;
  readonly replacementCalls: Array<{
    document: LiveReviewDocument;
    replacement: TextReplacement;
  }> = [];
  readonly replaceAllCalls: Array<{ document: LiveReviewDocument; text: string }> = [];
  readonly deleteCalls: vscode.Uri[] = [];
  readonly revealCalls: Array<{ document: LiveReviewDocument; line: number }> = [];
  readonly errors: string[] = [];
  readonly logs: Array<{ scope: string; error: unknown }> = [];
  replacementResult = true;
  replaceAllResult = true;
  replacementError: unknown;
  replaceAllError: unknown;
  deleteError: unknown;
  private readonly activeQueue: QueuedActiveDocument[] = [];

  activeDocument(): LiveReviewDocument | undefined {
    const queued = this.activeQueue.shift();
    if (typeof queued === 'function') {
      return queued();
    }
    return queued === undefined ? this.document : queued;
  }

  queueActive(...documents: QueuedActiveDocument[]): void {
    this.activeQueue.push(...documents);
  }

  async applyReplacement(
    document: LiveReviewDocument,
    replacement: TextReplacement,
  ): Promise<boolean> {
    this.replacementCalls.push({ document, replacement });
    if (this.replacementError !== undefined) {
      throw this.replacementError;
    }
    return this.replacementResult;
  }

  async replaceAll(document: LiveReviewDocument, text: string): Promise<boolean> {
    this.replaceAllCalls.push({ document, text });
    if (this.replaceAllError !== undefined) {
      throw this.replaceAllError;
    }
    return this.replaceAllResult;
  }

  async deleteToTrash(uri: vscode.Uri): Promise<void> {
    this.deleteCalls.push(uri);
    if (this.deleteError !== undefined) {
      throw this.deleteError;
    }
  }

  reveal(document: LiveReviewDocument, line: number): void {
    this.revealCalls.push({ document, line });
  }

  showError(message: string): void {
    this.errors.push(message);
  }

  log(scope: string, error: unknown): void {
    this.logs.push({ scope, error });
  }
}

function fakeUri(value: string): vscode.Uri {
  return { toString: () => value } as vscode.Uri;
}

function liveDocument(
  documentKey: string,
  text: string,
  overrides: Partial<LiveReviewDocument> = {},
): LiveReviewDocument {
  return {
    uri: fakeUri(documentKey),
    key: documentKey,
    text,
    version: 4,
    cursorLine: 0,
    lineCount: text.split('\n').length,
    eol: (text.includes('\r\n') ? 2 : 1) as vscode.EndOfLine,
    ...overrides,
  };
}

function installState(
  store: SnapshotStore,
  stateKey: string,
  baselineText: string,
  currentText: string,
  overrides: Partial<FileComparisonState> = {},
): FileComparisonState {
  const state: FileComparisonState = {
    baselineText,
    currentText,
    hunks: new LineDiffEngine().compute(baselineText, currentText),
    sourceRevision: 8,
    comparisonActive: true,
    pending: true,
    createdFile: false,
    ...overrides,
  };
  store.setComparison(stateKey, state);
  return state;
}

function reference(stateKey: string, state: FileComparisonState, hunkIndex = 0): HunkReference {
  return {
    key: stateKey,
    sourceRevision: state.sourceRevision,
    hunkIndex,
    expectedText: state.currentText,
  };
}

function setup(
  baselineText = 'a\nold\nz\n',
  currentText = 'a\nnew\nz\n',
  overrides: Partial<FileComparisonState> = {},
) {
  const store = new SnapshotStore();
  const view = new RecordingView();
  const coordinator = new ComparisonCoordinator(new LineDiffEngine(), store, view);
  const state = installState(store, key, baselineText, currentText, overrides);
  const host = new RecordingHost();
  host.document = liveDocument(key, currentText);
  const changed: string[] = [];
  const controller = new ReviewController(coordinator, host, (changedKey) => {
    changed.push(changedKey);
  });
  return { changed, controller, coordinator, host, state, store, view };
}

function expectNoHostMutation(host: RecordingHost): void {
  expect(host.replacementCalls).toEqual([]);
  expect(host.replaceAllCalls).toEqual([]);
  expect(host.deleteCalls).toEqual([]);
}

describe('ReviewController approvals', () => {
  it('approves the referenced hunk through coordinator state only', async () => {
    const { changed, controller, coordinator, host, state } = setup();
    const hunkReference = reference(key, state);

    await controller.approveHunk(hunkReference);

    expect(coordinator.state(key)).toMatchObject({
      baselineText: 'a\nnew\nz\n',
      currentText: 'a\nnew\nz\n',
      hunks: [],
      pending: false,
    });
    expect(changed).toEqual([key]);
    expectNoHostMutation(host);
  });

  it('approves all changes for the active key without touching another key or the host', async () => {
    const otherKey = 'file:///workspace/other.ts';
    const { changed, controller, coordinator, host, store } = setup();
    installState(store, otherKey, 'before', 'after');

    await controller.approveAll();

    expect(coordinator.state(key)).toMatchObject({
      baselineText: 'a\nnew\nz\n',
      hunks: [],
      pending: false,
    });
    expect(coordinator.state(otherKey)).toMatchObject({
      baselineText: 'before',
      currentText: 'after',
      pending: true,
    });
    expect(changed).toEqual([key]);
    expectNoHostMutation(host);
  });

  it('synchronizes a stale hunk action without changing state or the host', async () => {
    const { changed, controller, coordinator, host, state } = setup();
    const staleReference = { ...reference(key, state), sourceRevision: 7 };

    await controller.approveHunk(staleReference);

    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([key]);
    expectNoHostMutation(host);
  });

  it('synchronizes a missing hunk action without changing the host', async () => {
    const { changed, controller, host } = setup();
    const missingKey = 'file:///workspace/missing.ts';
    host.document = liveDocument(missingKey, 'content');

    await controller.approveHunk({
      key: missingKey,
      sourceRevision: 1,
      hunkIndex: 0,
      expectedText: 'content',
    });

    expect(changed).toEqual([missingKey]);
    expectNoHostMutation(host);
  });

  it('does not approve when the active document version changes before mutation', async () => {
    const { changed, controller, coordinator, host, state } = setup();
    host.queueActive(host.document, { ...host.document!, version: 5 });

    await controller.approveHunk(reference(key, state));

    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([key]);
    expectNoHostMutation(host);
  });
});

describe('ReviewController rejection edits', () => {
  const cases: Array<{
    name: string;
    baselineText: string;
    currentText: string;
    replacement: TextReplacement;
  }> = [
    {
      name: 'addition',
      baselineText: 'a\nz\n',
      currentText: 'a\nnew\nz\n',
      replacement: { startOffset: 2, endOffset: 6, replacementText: '' },
    },
    {
      name: 'deletion',
      baselineText: 'a\nold\nz\n',
      currentText: 'a\nz\n',
      replacement: { startOffset: 2, endOffset: 2, replacementText: 'old\n' },
    },
    {
      name: 'modification',
      baselineText: 'a\nold\nz\n',
      currentText: 'a\nnew\nz\n',
      replacement: { startOffset: 2, endOffset: 6, replacementText: 'old\n' },
    },
  ];

  for (const testCase of cases) {
    it(`applies the exact ${testCase.name} rejection plan and leaves recomputation to document change`, async () => {
      const { changed, controller, coordinator, host, state } = setup(
        testCase.baselineText,
        testCase.currentText,
      );

      await controller.rejectHunk(reference(key, state));

      expect(host.replacementCalls).toEqual([{
        document: host.document,
        replacement: testCase.replacement,
      }]);
      expect(host.replaceAllCalls).toEqual([]);
      expect(host.deleteCalls).toEqual([]);
      expect(coordinator.state(key)).toEqual(state);
      expect(coordinator.state(key)?.pending).toBe(true);
      expect(changed).toEqual([key]);
    });
  }

  it('rejects all existing-file changes by restoring the latest baseline', async () => {
    const { changed, controller, coordinator, host, state } = setup();

    await controller.rejectAll();

    expect(host.replaceAllCalls).toEqual([{
      document: host.document,
      text: 'a\nold\nz\n',
    }]);
    expect(host.replacementCalls).toEqual([]);
    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([key]);
  });

  it('rejects all against the partially accepted baseline after one hunk is approved', async () => {
    const baselineText = 'alpha\nbeta\ngamma\n';
    const currentText = 'ALPHA\nbeta\nGAMMA\n';
    const { changed, controller, coordinator, host, state } = setup(baselineText, currentText);

    await controller.approveHunk(reference(key, state, 0));
    changed.length = 0;
    await controller.rejectAll();

    expect(coordinator.state(key)).toMatchObject({
      baselineText: 'ALPHA\nbeta\ngamma\n',
      currentText,
      pending: true,
    });
    expect(host.replaceAllCalls).toEqual([{
      document: host.document,
      text: 'ALPHA\nbeta\ngamma\n',
    }]);
    expect(changed).toEqual([key]);
  });

  it('retains pending state and reports a false edit result', async () => {
    const { changed, controller, coordinator, host, state } = setup();
    host.replacementResult = false;

    await controller.rejectHunk(reference(key, state));

    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([]);
    expect(host.errors).toEqual(['Could not reject Codex changes.']);
    expect(host.logs).toHaveLength(1);
  });

  it('retains pending state and reports a thrown replacement error', async () => {
    const { changed, controller, coordinator, host, state } = setup();
    const failure = new Error('apply failed');
    host.replacementError = failure;

    await controller.rejectHunk(reference(key, state));

    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([]);
    expect(host.errors).toEqual(['Could not reject Codex changes.']);
    expect(host.logs).toEqual([{ scope: 'Reject Codex changes', error: failure }]);
  });

  it('synchronizes without editing when live text does not exactly match state', async () => {
    const { changed, controller, coordinator, host, state } = setup();
    host.document = liveDocument(key, 'changed elsewhere');

    await controller.rejectHunk(reference(key, state));

    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([key]);
    expectNoHostMutation(host);
    expect(host.errors).toEqual([]);
  });

  it('synchronizes without editing when the live version changes at the mutation guard', async () => {
    const { changed, controller, coordinator, host, state } = setup();
    host.queueActive(host.document, { ...host.document!, version: 5 });

    await controller.rejectHunk(reference(key, state));

    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([key]);
    expectNoHostMutation(host);
  });

  it('rechecks the hunk revision immediately before editing', async () => {
    const { changed, controller, coordinator, host, state } = setup();
    host.queueActive(host.document, () => {
      coordinator.invalidate(key);
      return host.document;
    });

    await controller.rejectHunk(reference(key, state));

    expect(coordinator.state(key)?.sourceRevision).toBe(9);
    expect(changed).toEqual([key]);
    expectNoHostMutation(host);
  });

  it('does not let an inactive URI target the active document', async () => {
    const { changed, controller, coordinator, host, state } = setup();
    const inactiveUri = fakeUri('file:///workspace/inactive.ts');

    await controller.rejectAll(inactiveUri);

    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual(['file:///workspace/inactive.ts']);
    expectNoHostMutation(host);
  });
});

describe('ReviewController created-file rejection', () => {
  function setupCreated() {
    return setup('', 'one\ntwo\n', { createdFile: true });
  }

  it('rejects one created-file hunk by trashing the file before clearing state', async () => {
    const { changed, controller, coordinator, host, state, view } = setupCreated();

    await controller.rejectHunk(reference(key, state));

    expect(host.deleteCalls).toEqual([host.document!.uri]);
    expect(host.replacementCalls).toEqual([]);
    expect(host.replaceAllCalls).toEqual([]);
    expect(coordinator.state(key)).toBeUndefined();
    expect(view.cleared).toEqual([key]);
    expect(changed).toEqual([key]);
  });

  it('rejects all created-file changes by trashing the file without an empty edit', async () => {
    const { changed, controller, coordinator, host } = setupCreated();

    await controller.rejectAll();

    expect(host.deleteCalls).toEqual([host.document!.uri]);
    expect(host.replacementCalls).toEqual([]);
    expect(host.replaceAllCalls).toEqual([]);
    expect(coordinator.state(key)).toBeUndefined();
    expect(changed).toEqual([key]);
  });

  it('retains created-file state and UI when trash deletion fails', async () => {
    const { changed, controller, coordinator, host, state, view } = setupCreated();
    const failure = new Error('trash unavailable');
    host.deleteError = failure;

    await controller.rejectAll();

    expect(coordinator.state(key)).toEqual(state);
    expect(view.cleared).toEqual([]);
    expect(changed).toEqual([]);
    expect(host.errors).toEqual(['Could not reject Codex changes.']);
    expect(host.logs).toEqual([{ scope: 'Reject Codex changes', error: failure }]);
  });
});

describe('ReviewController navigation', () => {
  function setupNavigation() {
    const result = setup();
    const hunks: readonly ChangeHunk[] = [2, 6, 10].map((modifiedStart) => ({
      kind: 'modification',
      originalStart: modifiedStart,
      originalEnd: modifiedStart + 1,
      modifiedStart,
      modifiedEnd: modifiedStart + 1,
      originalLines: ['old'],
      modifiedLines: ['new'],
    }));
    result.store.setComparison(key, { ...result.state, hunks });
    result.host.document = liveDocument(key, result.state.currentText, { cursorLine: 6 });
    return result;
  }

  it('reveals the next and previous hunk anchors in the active file', () => {
    const { controller, host } = setupNavigation();

    controller.nextChange();
    controller.previousChange();

    expect(host.revealCalls).toEqual([
      { document: host.document, line: 10 },
      { document: host.document, line: 2 },
    ]);
  });

  it('does not navigate an inactive URI', () => {
    const { controller, host } = setupNavigation();

    controller.nextChange(fakeUri('file:///workspace/inactive.ts'));

    expect(host.revealCalls).toEqual([]);
  });

  it('does nothing when active state is missing or not pending', () => {
    const missing = setupNavigation();
    missing.store.delete(key);
    missing.controller.nextChange();
    expect(missing.host.revealCalls).toEqual([]);

    const settled = setupNavigation();
    settled.store.setComparison(key, { ...settled.state, pending: false });
    settled.controller.previousChange();
    expect(settled.host.revealCalls).toEqual([]);
  });

  it('does nothing after disposal', async () => {
    const { controller, host, state } = setupNavigation();
    controller.dispose();

    controller.nextChange();
    await controller.rejectHunk(reference(key, state));

    expect(host.revealCalls).toEqual([]);
    expectNoHostMutation(host);
  });
});
