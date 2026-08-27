import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
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

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

class RecordingView implements ComparisonView {
  readonly cleared: string[] = [];
  readonly rendered: Array<{ key: string; hunks: readonly ChangeHunk[] }> = [];
  clearError: unknown;

  async render(renderedKey: string, hunks: readonly ChangeHunk[]): Promise<void> {
    this.rendered.push({ key: renderedKey, hunks });
  }

  clear(clearedKey: string): void {
    this.cleared.push(clearedKey);
    if (this.clearError !== undefined) {
      throw this.clearError;
    }
  }

  clearAll(): void {}
}

type ActiveDocumentResult = LiveReviewDocument | undefined;
type QueuedActiveDocument = ActiveDocumentResult | (() => ActiveDocumentResult);

class RecordingHost implements ReviewHost {
  document: LiveReviewDocument | undefined;
  readonly documents = new Map<string, LiveReviewDocument>();
  readonly files = new Map<string, string>();
  readonly replacementCalls: Array<{
    document: LiveReviewDocument;
    replacement: TextReplacement;
  }> = [];
  readonly replaceAllCalls: Array<{ document: LiveReviewDocument; text: string }> = [];
  readonly deleteCalls: vscode.Uri[] = [];
  readonly revealCalls: Array<{ document: LiveReviewDocument; line: number }> = [];
  readonly errors: string[] = [];
  readonly logs: Array<{ scope: string; error: unknown }> = [];
  replacementResult: boolean | Promise<boolean> = true;
  replaceAllResult: boolean | Promise<boolean> = true;
  replacementError: unknown;
  replaceAllError: unknown;
  deleteError: unknown;
  deleteResult: Promise<void> | undefined;
  restoreError: unknown;
  restoreResult: boolean | Promise<boolean> = true;
  afterAbsenceCheck: (() => void) | undefined;
  afterRestore: (() => void) | undefined;
  private readonly activeQueue: QueuedActiveDocument[] = [];

  activeDocument(): LiveReviewDocument | undefined {
    const queued = this.activeQueue.shift();
    if (typeof queued === 'function') {
      return queued();
    }
    return queued === undefined ? this.document : queued;
  }

  async reviewDocument(uri: vscode.Uri): Promise<LiveReviewDocument | undefined> {
    return this.documents.get(uri.toString());
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
    return await this.replacementResult;
  }

  async replaceAll(document: LiveReviewDocument, text: string): Promise<boolean> {
    this.replaceAllCalls.push({ document, text });
    if (this.replaceAllError !== undefined) {
      throw this.replaceAllError;
    }
    return await this.replaceAllResult;
  }

  async deleteToTrash(uri: vscode.Uri): Promise<void> {
    this.deleteCalls.push(uri);
    if (this.deleteError !== undefined) {
      throw this.deleteError;
    }
    await this.deleteResult;
    this.files.delete(uri.toString());
  }

  async isFileAbsent(uri: vscode.Uri): Promise<boolean> {
    const absent = !this.files.has(uri.toString());
    this.afterAbsenceCheck?.();
    return absent;
  }

  async restoreDeletedFile(uri: vscode.Uri, text: string): Promise<boolean> {
    const fileKey = uri.toString();
    if (this.files.has(fileKey)) {
      return false;
    }
    if (this.restoreError !== undefined) {
      throw this.restoreError;
    }
    if (!await this.restoreResult || this.files.has(fileKey)) {
      return false;
    }
    this.files.set(fileKey, text);
    this.afterRestore?.();
    return true;
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
    lifecycle: 'existing',
    provenance: {
      confidence: 'exact',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemIds: ['item-1'],
    },
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
  afterStateChanged?: (key: string) => void,
  reviewResources: () => readonly vscode.Uri[] = () => [],
) {
  const store = new SnapshotStore();
  const view = new RecordingView();
  const coordinator = new ComparisonCoordinator(new LineDiffEngine(), store, view);
  const state = installState(store, key, baselineText, currentText, overrides);
  const host = new RecordingHost();
  if (state.lifecycle !== 'deleted') {
    host.files.set(key, currentText);
    host.document = liveDocument(key, currentText);
    host.documents.set(key, host.document);
  }
  const changed: string[] = [];
  const controller = new ReviewController(coordinator, host, (changedKey) => {
    changed.push(changedKey);
    afterStateChanged?.(changedKey);
  }, undefined, undefined, undefined, reviewResources);
  return { changed, controller, coordinator, host, state, store, view };
}

function expectNoHostMutation(host: RecordingHost): void {
  expect(host.replacementCalls).toEqual([]);
  expect(host.replaceAllCalls).toEqual([]);
  expect(host.deleteCalls).toEqual([]);
}

function applyReplacement(text: string, replacement: TextReplacement): string {
  return text.slice(0, replacement.startOffset)
    + replacement.replacementText
    + text.slice(replacement.endOffset);
}

describe('ReviewController approvals', () => {
  it('approves every file from the initial Codex Changes snapshot', async () => {
    const otherKey = 'file:///workspace/other.ts';
    const resources = [fakeUri(key), fakeUri(otherKey)];
    const { changed, controller, coordinator, host, store } = setup(
      undefined,
      undefined,
      {},
      undefined,
      () => resources,
    );
    const otherState = installState(store, otherKey, 'before', 'after');
    host.documents.set(otherKey, liveDocument(otherKey, otherState.currentText));

    const approveAllFiles = (controller as unknown as {
      approveAllFiles(): Promise<void>;
    }).approveAllFiles;
    expect(approveAllFiles).toBeTypeOf('function');
    await approveAllFiles.call(controller);

    expect(coordinator.state(key)?.pending).toBe(false);
    expect(coordinator.state(otherKey)?.pending).toBe(false);
    expect(changed).toEqual([key, otherKey]);
  });

  it('approves a selected inactive file without changing the active file', async () => {
    const otherKey = 'file:///workspace/other.ts';
    const { changed, controller, coordinator, host, state, store } = setup();
    const otherState = installState(store, otherKey, 'before', 'after');
    const otherDocument = liveDocument(otherKey, otherState.currentText);
    host.documents.set(otherKey, otherDocument);

    const approveFile = (controller as unknown as {
      approveFile(uri: vscode.Uri): Promise<void>;
    }).approveFile;
    expect(approveFile).toBeTypeOf('function');
    await approveFile.call(controller, otherDocument.uri);

    expect(coordinator.state(otherKey)).toMatchObject({
      baselineText: 'after',
      hunks: [],
      pending: false,
    });
    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([otherKey]);
    expectNoHostMutation(host);
  });

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
  it('rejects the remaining files when one listed resource is stale', async () => {
    const staleKey = 'file:///workspace/stale.ts';
    const otherKey = 'file:///workspace/other.ts';
    const resources = [fakeUri(staleKey), fakeUri(key), fakeUri(otherKey)];
    const { changed, controller, host, store } = setup(
      undefined,
      undefined,
      {},
      undefined,
      () => resources,
    );
    const staleState = installState(store, staleKey, 'stale-before', 'stale-after');
    host.documents.set(staleKey, liveDocument(staleKey, `${staleState.currentText}!`));
    const otherState = installState(store, otherKey, 'before', 'after');
    const otherDocument = liveDocument(otherKey, otherState.currentText);
    host.documents.set(otherKey, otherDocument);

    const rejectAllFiles = (controller as unknown as {
      rejectAllFiles(): Promise<void>;
    }).rejectAllFiles;
    expect(rejectAllFiles).toBeTypeOf('function');
    await rejectAllFiles.call(controller);

    expect(host.replaceAllCalls).toEqual([
      { document: host.document, text: 'a\nold\nz\n' },
      { document: otherDocument, text: 'before' },
    ]);
    expect(changed).toEqual([staleKey, key, otherKey]);
  });

  it('rejects a selected inactive file without editing the active file', async () => {
    const otherKey = 'file:///workspace/other.ts';
    const { changed, controller, coordinator, host, state, store } = setup();
    const otherState = installState(store, otherKey, 'before', 'after');
    const otherDocument = liveDocument(otherKey, otherState.currentText);
    host.documents.set(otherKey, otherDocument);

    const rejectFile = (controller as unknown as {
      rejectFile(uri: vscode.Uri): Promise<void>;
    }).rejectFile;
    expect(rejectFile).toBeTypeOf('function');
    await rejectFile.call(controller, otherDocument.uri);

    expect(host.replaceAllCalls).toEqual([{ document: otherDocument, text: 'before' }]);
    expect(coordinator.state(otherKey)).toEqual(otherState);
    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([otherKey]);
  });

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

  const eofCases = [
    { name: 'a final LF', baselineText: 'x\n', currentText: 'x' },
    { name: 'no final LF', baselineText: 'x', currentText: 'x\n' },
    { name: 'changed EOF content and CRLF', baselineText: 'old\r\n', currentText: 'new' },
    { name: 'changed EOF content without CRLF', baselineText: 'old', currentText: 'new\r\n' },
  ];

  for (const testCase of eofCases) {
    it(`restores ${testCase.name} exactly from a real diff hunk`, async () => {
      const { controller, host, state } = setup(testCase.baselineText, testCase.currentText);

      await controller.rejectHunk(reference(key, state));

      expect(host.replacementCalls).toHaveLength(1);
      expect(applyReplacement(
        testCase.currentText,
        host.replacementCalls[0].replacement,
      )).toBe(testCase.baselineText);
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

  it('logs a post-edit hunk synchronization failure without claiming rejection failed', async () => {
    const failure = new Error('sync failed');
    const { changed, controller, coordinator, host, state } = setup(
      'a\nold\nz\n',
      'a\nnew\nz\n',
      {},
      () => { throw failure; },
    );

    await controller.rejectHunk(reference(key, state));

    expect(host.replacementCalls).toHaveLength(1);
    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([key]);
    expect(host.errors).toEqual([]);
    expect(host.logs).toEqual([{
      scope: 'Synchronize Codex review state',
      error: failure,
    }]);
  });

  it('logs a post-edit reject-all synchronization failure without claiming rejection failed', async () => {
    const failure = new Error('sync failed');
    const { changed, controller, coordinator, host, state } = setup(
      'a\nold\nz\n',
      'a\nnew\nz\n',
      {},
      () => { throw failure; },
    );

    await controller.rejectAll();

    expect(host.replaceAllCalls).toHaveLength(1);
    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([key]);
    expect(host.errors).toEqual([]);
    expect(host.logs).toEqual([{
      scope: 'Synchronize Codex review state',
      error: failure,
    }]);
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

  it('serializes overlapping hunk and all-file rejections before revalidating the second action', async () => {
    const { changed, controller, host, state } = setup();
    const firstEdit = deferred<boolean>();
    host.replacementResult = firstEdit.promise;

    const first = controller.rejectHunk(reference(key, state));
    const second = controller.rejectAll();
    await Promise.resolve();

    expect(host.replacementCalls).toHaveLength(1);
    expect(host.replaceAllCalls).toEqual([]);

    host.document = liveDocument(key, 'a\nold\nz\n', { version: 5 });
    firstEdit.resolve(true);
    await Promise.all([first, second]);

    expect(host.replacementCalls).toHaveLength(1);
    expect(host.replaceAllCalls).toEqual([]);
    expect(changed).toEqual([key, key]);
  });

  it('releases the per-key rejection queue after a false or throwing host edit', async () => {
    for (const failedResult of [false, new Error('apply failed')]) {
      const { controller, host, state } = setup();
      const firstEdit = deferred<boolean>();
      host.replacementResult = firstEdit.promise;

      const first = controller.rejectHunk(reference(key, state));
      const second = controller.rejectHunk(reference(key, state));
      await Promise.resolve();
      expect(host.replacementCalls).toHaveLength(1);

      host.replacementResult = true;
      if (failedResult === false) {
        firstEdit.resolve(false);
      } else {
        firstEdit.reject(failedResult);
      }
      await Promise.all([first, second]);

      expect(host.replacementCalls).toHaveLength(2);
      expect(host.errors).toEqual(['Could not reject Codex changes.']);
    }
  });
});

describe('ReviewController mutation serialization', () => {
  for (const approval of ['hunk', 'all'] as const) {
    it(`waits for a same-key Reject before ${approval === 'hunk' ? 'Approve Hunk' : 'Approve All'} revalidation`, async () => {
      const { controller, coordinator, host, state } = setup('', 'one\ntwo\n', { lifecycle: 'created' });
      const firstDelete = deferred<void>();
      host.deleteResult = firstDelete.promise;

      const rejection = controller.rejectAll();
      await Promise.resolve();
      expect(host.deleteCalls).toHaveLength(1);
      const approvalRun = approval === 'hunk'
        ? controller.approveHunk(reference(key, state))
        : controller.approveAll();
      await Promise.resolve();

      expect(coordinator.state(key)).toEqual(state);
      firstDelete.resolve();
      await Promise.all([rejection, approvalRun]);

      expect(coordinator.state(key)).toBeUndefined();
      expect(host.deleteCalls).toHaveLength(1);
    });
  }

  for (const rejection of ['hunk', 'all'] as const) {
    it(`waits for a same-key Approve Hunk before ${rejection === 'hunk' ? 'Reject Hunk' : 'Reject All'} revalidation`, async () => {
      const { controller, coordinator, host, state } = setup();
      const approvalGate = deferred<void>();
      const approveHunk = coordinator.approveHunk.bind(coordinator);
      vi.spyOn(coordinator, 'approveHunk').mockImplementation(async (hunkReference) => {
        await approvalGate.promise;
        return approveHunk(hunkReference);
      });

      const approvalRun = controller.approveHunk(reference(key, state));
      await Promise.resolve();
      const rejectionRun = rejection === 'hunk'
        ? controller.rejectHunk(reference(key, state))
        : controller.rejectAll();
      await Promise.resolve();

      expectNoHostMutation(host);
      approvalGate.resolve();
      await Promise.all([approvalRun, rejectionRun]);

      expect(coordinator.state(key)?.pending).toBe(false);
      expectNoHostMutation(host);
    });
  }

  it('keeps different file keys independent while one mutation is deferred', async () => {
    const otherKey = 'file:///workspace/other.ts';
    const { controller, coordinator, host, state, store } = setup('', 'created\n', { lifecycle: 'created' });
    const otherState = installState(store, otherKey, 'before', 'after');
    const firstDelete = deferred<void>();
    host.deleteResult = firstDelete.promise;

    const first = controller.rejectAll(fakeUri(key));
    await Promise.resolve();
    expect(host.deleteCalls).toHaveLength(1);
    host.document = liveDocument(otherKey, otherState.currentText);
    await controller.approveAll(fakeUri(otherKey));

    expect(coordinator.state(key)).toEqual(state);
    expect(coordinator.state(otherKey)?.pending).toBe(false);
    firstDelete.resolve();
    await first;
    expect(coordinator.state(key)).toBeUndefined();
  });

  it('runs the next same-key mutation after an approval throws', async () => {
    const { controller, coordinator, host, state } = setup();
    const failure = new Error('approval failed');
    vi.spyOn(coordinator, 'approveHunk').mockRejectedValueOnce(failure);

    const approval = controller.approveHunk(reference(key, state));
    const rejection = controller.rejectHunk(reference(key, state));

    await expect(approval).rejects.toBe(failure);
    await rejection;
    expect(host.replacementCalls).toHaveLength(1);
  });
});

describe('ReviewController created-file rejection', () => {
  function setupCreated() {
    return setup('', 'one\ntwo\n', { lifecycle: 'created' });
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

  it('logs coordinator cleanup failure after trash deletion without claiming deletion failed', async () => {
    const { changed, controller, coordinator, host, state, view } = setupCreated();
    const failure = new Error('view clear failed');
    view.clearError = failure;

    await controller.rejectHunk(reference(key, state));

    expect(host.deleteCalls).toEqual([host.document!.uri]);
    expect(coordinator.state(key)).toBeUndefined();
    expect(view.cleared).toEqual([key]);
    expect(changed).toEqual([key]);
    expect(host.errors).toEqual([]);
    expect(host.logs).toEqual([{
      scope: 'Synchronize Codex review state',
      error: failure,
    }]);
  });

  it('logs callback failure after trash deletion without claiming deletion failed', async () => {
    const failure = new Error('sync failed');
    const { changed, controller, coordinator, host } = setup(
      '',
      'one\ntwo\n',
      { lifecycle: 'created' },
      () => { throw failure; },
    );

    await controller.rejectAll();

    expect(host.deleteCalls).toEqual([host.document!.uri]);
    expect(coordinator.state(key)).toBeUndefined();
    expect(changed).toEqual([key]);
    expect(host.errors).toEqual([]);
    expect(host.logs).toEqual([{
      scope: 'Synchronize Codex review state',
      error: failure,
    }]);
  });

  it('serializes overlapping created-file rejections through one trash operation', async () => {
    const { controller, coordinator, host, state } = setupCreated();
    const firstDelete = deferred<void>();
    host.deleteResult = firstDelete.promise;

    const first = controller.rejectHunk(reference(key, state));
    const second = controller.rejectAll();
    await Promise.resolve();

    expect(host.deleteCalls).toHaveLength(1);
    firstDelete.resolve();
    await Promise.all([first, second]);

    expect(host.deleteCalls).toHaveLength(1);
    expect(coordinator.state(key)).toBeUndefined();
  });

  describe('empty created-file lifecycle review', () => {
    function setupEmptyCreated(reviewResources: () => readonly vscode.Uri[] = () => []) {
      return setup('', '', { lifecycle: 'created' }, undefined, reviewResources);
    }

    it('approves an empty created file from its SCM file action', async () => {
      const { changed, controller, coordinator, host } = setupEmptyCreated();

      await controller.approveFile(fakeUri(key));

      expect(host.files.get(key)).toBe('');
      expect(coordinator.state(key)).toMatchObject({
        baselineText: '',
        currentText: '',
        comparisonActive: false,
        pending: false,
        lifecycle: 'existing',
      });
      expect(changed).toEqual([key]);
      expectNoHostMutation(host);
    });

    it('rejects an empty created file from its SCM file action', async () => {
      const { changed, controller, coordinator, host } = setupEmptyCreated();

      await controller.rejectFile(fakeUri(key));

      expect(host.files.has(key)).toBe(false);
      expect(host.deleteCalls.map((uri) => uri.toString())).toEqual([key]);
      expect(coordinator.state(key)).toBeUndefined();
      expect(changed).toEqual([key]);
    });

    it('approves and rejects empty created files from active-editor all-file commands', async () => {
      const approved = setupEmptyCreated();
      await approved.controller.approveAll();
      expect(approved.host.files.get(key)).toBe('');
      expect(approved.coordinator.state(key)?.comparisonActive).toBe(false);

      const rejected = setupEmptyCreated();
      await rejected.controller.rejectAll();
      expect(rejected.host.files.has(key)).toBe(false);
      expect(rejected.coordinator.state(key)).toBeUndefined();
    });

    it('routes bulk approval and rejection through empty created-file actions', async () => {
      const uri = fakeUri(key);
      const approved = setupEmptyCreated(() => [uri]);
      await approved.controller.approveAllFiles();
      expect(approved.host.files.get(key)).toBe('');
      expect(approved.coordinator.state(key)?.comparisonActive).toBe(false);

      const rejected = setupEmptyCreated(() => [uri]);
      await rejected.controller.rejectAllFiles();
      expect(rejected.host.files.has(key)).toBe(false);
      expect(rejected.coordinator.state(key)).toBeUndefined();
    });

    for (const action of ['approveHunk', 'rejectHunk'] as const) {
      it(`keeps ${action} unavailable for an empty created file`, async () => {
        const { controller, coordinator, host, state } = setupEmptyCreated();

        await controller[action](reference(key, state));

        expect(host.files.get(key)).toBe('');
        expect(coordinator.state(key)).toEqual(state);
        expectNoHostMutation(host);
      });
    }
  });
});

describe('ReviewController deleted-file decisions', () => {
  function setupDeleted(baselineText = 'before\n', reviewResources: () => readonly vscode.Uri[] = () => []) {
    return setup(
      baselineText,
      '',
      { lifecycle: 'deleted' },
      undefined,
      reviewResources,
    );
  }

  it('approves an absent deletion without acquiring a review document', async () => {
    const { changed, controller, coordinator, host, view } = setupDeleted();
    const reviewDocument = vi.spyOn(host, 'reviewDocument');

    await controller.approveFile(fakeUri(key));

    expect(host.files.has(key)).toBe(false);
    expect(coordinator.state(key)).toBeUndefined();
    expect(view.cleared).toEqual([key]);
    expect(changed).toEqual([key]);
    expect(reviewDocument).not.toHaveBeenCalled();
    expectNoHostMutation(host);
  });

  for (const action of ['approveHunk', 'rejectHunk', 'approveAll', 'rejectAll'] as const) {
    it(`does not let a directly invoked ${action} editor command decide a deleted file`, async () => {
      const { controller, coordinator, host, state } = setupDeleted();
      host.document = liveDocument(key, '');
      host.documents.set(key, host.document);

      if (action === 'approveHunk') {
        await controller.approveHunk(reference(key, state));
      } else if (action === 'rejectHunk') {
        await controller.rejectHunk(reference(key, state));
      } else if (action === 'approveAll') {
        await controller.approveAll();
      } else {
        await controller.rejectAll();
      }

      expect(host.files.has(key)).toBe(false);
      expect(coordinator.state(key)).toEqual(state);
      expectNoHostMutation(host);
    });
  }

  it('keeps deletion review active when approval finds a recreated path', async () => {
    const { changed, controller, coordinator, host, state } = setupDeleted();
    host.files.set(key, 'recreated elsewhere\n');

    await controller.approveFile(fakeUri(key));

    expect(host.files.get(key)).toBe('recreated elsewhere\n');
    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([]);
    expect(host.errors).toHaveLength(1);
    expect(host.logs).toHaveLength(1);
    expectNoHostMutation(host);
  });

  it('keeps deletion review active when approval becomes stale after the absence check', async () => {
    const { changed, controller, coordinator, host } = setupDeleted();
    host.afterAbsenceCheck = () => coordinator.invalidate(key);

    await controller.approveFile(fakeUri(key));

    expect(host.files.has(key)).toBe(false);
    expect(coordinator.state(key)).toMatchObject({
      lifecycle: 'deleted',
      comparisonActive: true,
      sourceRevision: 9,
    });
    expect(changed).toEqual([]);
    expect(host.errors).toHaveLength(1);
    expect(host.logs).toHaveLength(1);
  });

  it.each([
    { name: 'non-empty', baselineText: 'before\r\nexact\n' },
    { name: 'empty zero-hunk', baselineText: '' },
  ])('rejects a $name deletion by recreating its exact baseline', async ({ baselineText }) => {
    const { changed, controller, coordinator, host, view } = setupDeleted(baselineText);

    await controller.rejectFile(fakeUri(key));

    expect(host.files.get(key)).toBe(baselineText);
    expect(coordinator.state(key)).toMatchObject({
      baselineText,
      currentText: baselineText,
      hunks: [],
      comparisonActive: false,
      pending: false,
      lifecycle: 'existing',
    });
    expect(view.cleared).toEqual([key]);
    expect(changed).toEqual([key]);
    expect(host.errors).toEqual([]);
    expectNoHostMutation(host);
  });

  it('refuses to overwrite a path recreated before deletion rejection', async () => {
    const { changed, controller, coordinator, host, state } = setupDeleted();
    host.files.set(key, 'new owner\n');

    await controller.rejectFile(fakeUri(key));

    expect(host.files.get(key)).toBe('new owner\n');
    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([]);
    expect(host.errors).toHaveLength(1);
    expect(host.logs).toHaveLength(1);
  });

  it('leaves review active and reports a restore write failure', async () => {
    const { changed, controller, coordinator, host, state } = setupDeleted();
    const failure = new Error('write denied');
    host.restoreError = failure;

    await controller.rejectFile(fakeUri(key));

    expect(host.files.has(key)).toBe(false);
    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([]);
    expect(host.errors).toHaveLength(1);
    expect(host.logs).toEqual([{ scope: 'Reject Codex changes', error: failure }]);
  });

  it('leaves restored deletion review active when its revision becomes stale during the write', async () => {
    const { changed, controller, coordinator, host } = setupDeleted();
    host.afterRestore = () => coordinator.invalidate(key);

    await controller.rejectFile(fakeUri(key));

    expect(host.files.get(key)).toBe('before\n');
    expect(coordinator.state(key)).toMatchObject({
      lifecycle: 'deleted',
      comparisonActive: true,
      pending: true,
      sourceRevision: 9,
    });
    expect(changed).toEqual([]);
    expect(host.errors).toHaveLength(1);
    expect(host.logs).toHaveLength(1);
  });

  it('routes bulk deleted-file rejection through the filesystem decision', async () => {
    const uri = fakeUri(key);
    const { controller, coordinator, host } = setupDeleted('bulk\n', () => [uri]);

    await controller.rejectAllFiles();

    expect(host.files.get(key)).toBe('bulk\n');
    expect(coordinator.state(key)?.comparisonActive).toBe(false);
  });
});

describe('ReviewController in-flight disposal', () => {
  it('suppresses user-facing failure UI when a deferred host failure arrives after dispose', async () => {
    const { changed, controller, coordinator, host, state } = setup();
    const result = deferred<boolean>();
    const failure = new Error('late apply failure');
    host.replacementResult = result.promise;

    const rejection = controller.rejectHunk(reference(key, state));
    await Promise.resolve();
    expect(host.replacementCalls).toHaveLength(1);
    controller.dispose();
    result.reject(failure);
    await rejection;

    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([]);
    expect(host.errors).toEqual([]);
    expect(host.logs).toEqual([{ scope: 'Reject Codex changes', error: failure }]);
  });

  it('does not synchronize after a deferred existing-file edit succeeds after dispose', async () => {
    const { changed, controller, coordinator, host, state } = setup();
    const result = deferred<boolean>();
    host.replacementResult = result.promise;

    const rejection = controller.rejectHunk(reference(key, state));
    await Promise.resolve();
    expect(host.replacementCalls).toHaveLength(1);
    controller.dispose();
    result.resolve(true);
    await rejection;

    expect(coordinator.state(key)).toEqual(state);
    expect(changed).toEqual([]);
    expect(host.errors).toEqual([]);
  });

  it('clears created-file state but does not synchronize after deferred trash succeeds after dispose', async () => {
    const { changed, controller, coordinator, host } = setup(
      '',
      'one\ntwo\n',
      { lifecycle: 'created' },
    );
    const result = deferred<void>();
    host.deleteResult = result.promise;

    const rejection = controller.rejectAll();
    await Promise.resolve();
    expect(host.deleteCalls).toHaveLength(1);
    controller.dispose();
    result.resolve();
    await rejection;

    expect(coordinator.state(key)).toBeUndefined();
    expect(changed).toEqual([]);
    expect(host.errors).toEqual([]);
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
