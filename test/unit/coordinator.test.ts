import { describe, expect, it, vi } from 'vitest';
import { PerKeyDebouncer } from '../../src/changePolicy';
import { ComparisonCoordinator, ComparisonView } from '../../src/coordinator';
import { LineDiffEngine } from '../../src/diffEngine';
import { SnapshotStore } from '../../src/snapshotStore';
import type { ChangeHunk, HunkReference } from '../../src/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

const olderHunks: readonly ChangeHunk[] = [{
  kind: 'modification',
  originalStart: 0,
  originalEnd: 1,
  modifiedStart: 0,
  modifiedEnd: 1,
  originalLines: ['baseline'],
  modifiedLines: ['old-result'],
}];

const newerHunks: readonly ChangeHunk[] = [{
  kind: 'modification',
  originalStart: 0,
  originalEnd: 1,
  modifiedStart: 0,
  modifiedEnd: 1,
  originalLines: ['baseline'],
  modifiedLines: ['new-result'],
}];

const createdHunks: readonly ChangeHunk[] = [{
  kind: 'addition',
  originalStart: 0,
  originalEnd: 0,
  modifiedStart: 0,
  modifiedEnd: 2,
  originalLines: [],
  modifiedLines: ['const value = 1;', 'export { value };'],
}];

class FakeDiffEngine {
  readonly calls: Array<{ original: string; modified: string }> = [];
  private readonly results: Array<readonly ChangeHunk[] | Promise<readonly ChangeHunk[]>> = [];

  queue(...results: Array<readonly ChangeHunk[] | Promise<readonly ChangeHunk[]>>): void {
    this.results.push(...results);
  }

  compute(original: string, modified: string): readonly ChangeHunk[] | Promise<readonly ChangeHunk[]> {
    this.calls.push({ original, modified });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error('No fake diff result queued');
    }
    return result;
  }
}

class FakeView implements ComparisonView {
  readonly visible = new Set<string>();
  readonly renders: Array<{ key: string; hunks: readonly ChangeHunk[] }> = [];
  readonly renderStarts: Array<{ key: string; hunks: readonly ChangeHunk[] }> = [];
  readonly renderedHunks = new Map<string, readonly ChangeHunk[]>();
  private readonly renderResults: Array<Promise<void>> = [];
  readonly clear = vi.fn((key: string) => {
    this.renderedHunks.delete(key);
  });
  readonly clearAll = vi.fn(() => {
    this.renderedHunks.clear();
  });

  queueRender(...results: Promise<void>[]): void {
    this.renderResults.push(...results);
  }

  async render(key: string, hunks: readonly ChangeHunk[]): Promise<void> {
    this.renderStarts.push({ key, hunks });
    await this.renderResults.shift();
    if (this.visible.has(key)) {
      this.renders.push({ key, hunks });
      this.renderedHunks.set(key, hunks);
    }
  }
}

function setup() {
  const engine = new FakeDiffEngine();
  const store = new SnapshotStore();
  const view = new FakeView();
  const debouncer = new PerKeyDebouncer<string>();
  const coordinator = new ComparisonCoordinator(engine, store, view, debouncer);
  return { coordinator, debouncer, engine, store, view };
}

describe('ComparisonCoordinator', () => {
  const key = 'file:///workspace/file.ts';

  it('treats newly created content as an addition from an empty baseline', async () => {
    const { coordinator, engine, store, view } = setup();
    view.visible.add(key);
    engine.queue(createdHunks);
    const externalCreate = (coordinator as ComparisonCoordinator & {
      externalCreate?: (createdKey: string, text: string) => Promise<void>;
    }).externalCreate;

    expect(typeof externalCreate).toBe('function');
    if (externalCreate === undefined) {
      return;
    }
    await externalCreate.call(coordinator, key, 'const value = 1;\nexport { value };\n');

    expect(engine.calls).toEqual([{
      original: '',
      modified: 'const value = 1;\nexport { value };\n',
    }]);
    expect(store.get(key)).toMatchObject({
      baselineText: '',
      currentText: 'const value = 1;\nexport { value };\n',
      hunks: createdHunks,
      comparisonActive: true,
      createdFile: true,
    });
    expect(view.renders).toEqual([{ key, hunks: createdHunks }]);
  });

  it('clears created-file origin when creation produces no unresolved hunks', async () => {
    const { coordinator, engine, store, view } = setup();
    engine.queue([]);

    await coordinator.externalCreate(key, 'created without changes');

    expect(store.get(key)).toMatchObject({
      baselineText: '',
      currentText: 'created without changes',
      hunks: [],
      comparisonActive: false,
      pending: false,
      createdFile: false,
    });
    expect(view.clear).toHaveBeenCalledWith(key);
  });

  it('seeds unseen external content without diffing or rendering', async () => {
    const { coordinator, engine, store, view } = setup();

    await coordinator.externalChange(key, 'baseline');

    expect(store.get(key)).toMatchObject({
      baselineText: 'baseline',
      currentText: 'baseline',
      hunks: [],
      pending: false,
      createdFile: false,
    });
    expect(engine.calls).toEqual([]);
    expect(view.renders).toEqual([]);
  });

  it('diffs a later external write against the accepted baseline', async () => {
    const { coordinator, engine, store, view } = setup();
    coordinator.seed(key, 'baseline');
    view.visible.add(key);
    engine.queue(newerHunks);

    await coordinator.externalChange(key, 'new-result');

    expect(engine.calls).toEqual([{ original: 'baseline', modified: 'new-result' }]);
    expect(store.get(key)).toMatchObject({
      baselineText: 'baseline',
      currentText: 'new-result',
      hunks: newerHunks,
    });
    expect(view.renders).toEqual([{ key, hunks: newerHunks }]);
  });

  it('keeps an invisible comparison pending and renders it on show', async () => {
    const { coordinator, engine, store, view } = setup();
    coordinator.seed(key, 'baseline');
    engine.queue(newerHunks);

    await coordinator.externalChange(key, 'new-result');
    expect(view.renders).toEqual([]);
    expect(store.get(key)?.pending).toBe(true);

    view.visible.add(key);
    await coordinator.show(key);

    expect(view.renders).toEqual([{ key, hunks: newerHunks }]);
    expect(store.get(key)?.pending).toBe(false);
  });

  it('recomputes document edits against the original accepted baseline', async () => {
    const { coordinator, engine, view } = setup();
    coordinator.seed(key, 'baseline');
    view.visible.add(key);
    engine.queue(olderHunks, newerHunks);
    await coordinator.externalChange(key, 'old-result');

    await coordinator.documentEdit(key, 'new-result');

    expect(engine.calls).toEqual([
      { original: 'baseline', modified: 'old-result' },
      { original: 'baseline', modified: 'new-result' },
    ]);
    expect(view.renders.at(-1)).toEqual({ key, hunks: newerHunks });
  });

  it('accepts saved text and clears the comparison immediately', () => {
    const { coordinator, store, view } = setup();
    coordinator.seed(key, 'baseline');
    store.setComparison(key, {
      baselineText: 'baseline',
      currentText: 'changed',
      hunks: newerHunks,
      sourceRevision: store.get(key)!.sourceRevision,
      comparisonActive: true,
      pending: true,
      createdFile: false,
    });

    coordinator.save(key, 'saved');

    expect(store.get(key)).toMatchObject({
      baselineText: 'saved',
      currentText: 'saved',
      hunks: [],
      pending: false,
      createdFile: false,
    });
    expect(view.clear).toHaveBeenCalledWith(key);
  });

  it('rejects a deferred diff after save accepts a newer baseline', async () => {
    const { coordinator, engine, store, view } = setup();
    const result = deferred<readonly ChangeHunk[]>();
    coordinator.seed(key, 'baseline');
    view.visible.add(key);
    engine.queue(result.promise);

    const run = coordinator.externalChange(key, 'old-result');
    coordinator.save(key, 'saved');
    result.resolve(olderHunks);
    await run;

    expect(store.get(key)).toMatchObject({
      baselineText: 'saved',
      currentText: 'saved',
      hunks: [],
      pending: false,
    });
    expect(view.renders).toEqual([]);
  });

  it('deletes state, cancels keyed work, and clears its view', () => {
    vi.useFakeTimers();
    try {
      const { coordinator, debouncer, store, view } = setup();
      const pending = vi.fn();
      coordinator.seed(key, 'baseline');
      debouncer.schedule(key, 100, pending);

      coordinator.delete(key);
      vi.advanceTimersByTime(100);

      expect(store.get(key)).toBeUndefined();
      expect(pending).not.toHaveBeenCalled();
      expect(view.clear).toHaveBeenCalledWith(key);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a deferred diff after delete removes the URI state', async () => {
    const { coordinator, engine, store, view } = setup();
    const result = deferred<readonly ChangeHunk[]>();
    coordinator.seed(key, 'baseline');
    view.visible.add(key);
    engine.queue(result.promise);

    const run = coordinator.externalChange(key, 'old-result');
    coordinator.delete(key);
    result.resolve(olderHunks);
    await run;

    expect(store.get(key)).toBeUndefined();
    expect(view.renders).toEqual([]);
  });

  it('does not activate a comparison session for identical external content', async () => {
    const { coordinator, engine, store, view } = setup();
    coordinator.seed(key, 'baseline');
    view.visible.add(key);
    engine.queue([], newerHunks);

    await coordinator.externalChange(key, 'baseline');
    await coordinator.documentEdit(key, 'new-result');

    expect(store.get(key)).toMatchObject({
      comparisonActive: false,
      hunks: [],
      pending: false,
    });
    expect(engine.calls).toEqual([{ original: 'baseline', modified: 'baseline' }]);
    expect(view.renders).toEqual([]);
  });

  it('keeps an active session when a user temporarily returns to the baseline', async () => {
    const { coordinator, engine, store, view } = setup();
    coordinator.seed(key, 'baseline');
    view.visible.add(key);
    engine.queue(olderHunks, [], newerHunks);

    await coordinator.externalChange(key, 'old-result');
    await coordinator.documentEdit(key, 'baseline');

    expect(store.get(key)).toMatchObject({
      baselineText: 'baseline',
      currentText: 'baseline',
      comparisonActive: true,
      hunks: [],
      pending: false,
    });

    await coordinator.documentEdit(key, 'new-result');

    expect(engine.calls).toEqual([
      { original: 'baseline', modified: 'old-result' },
      { original: 'baseline', modified: 'baseline' },
      { original: 'baseline', modified: 'new-result' },
    ]);
    expect(view.renders.at(-1)).toEqual({ key, hunks: newerHunks });
  });

  it('checks a live-document guard before applying a deferred comparison', async () => {
    const { coordinator, engine, store, view } = setup();
    const result = deferred<readonly ChangeHunk[]>();
    let liveDocumentIsCurrent = true;
    coordinator.seed(key, 'baseline');
    view.visible.add(key);
    engine.queue(result.promise);

    const run = coordinator.externalChange(
      key,
      'old-result',
      () => liveDocumentIsCurrent,
    );
    liveDocumentIsCurrent = false;
    result.resolve(olderHunks);
    await run;

    expect(store.get(key)?.hunks).toEqual([]);
    expect(view.renders).toEqual([]);
  });

  it('invalidates an in-flight diff synchronously before debounced recomputation', async () => {
    const { coordinator, engine, store, view } = setup();
    const result = deferred<readonly ChangeHunk[]>();
    coordinator.seed(key, 'baseline');
    view.visible.add(key);
    engine.queue(result.promise);

    const run = coordinator.externalChange(key, 'old-result');
    const invalidate = (coordinator as ComparisonCoordinator & {
      invalidate?: (invalidatedKey: string) => void;
    }).invalidate;
    expect(invalidate).toBeTypeOf('function');
    invalidate?.call(coordinator, key);
    result.resolve(olderHunks);
    await run;

    expect(store.get(key)?.hunks).toEqual([]);
    expect(view.renders).toEqual([]);
  });

  it('lets a newer revision win', async () => {
    const { coordinator, engine, view } = setup();
    const first = deferred<readonly ChangeHunk[]>();
    coordinator.seed(key, 'baseline');
    view.visible.add(key);
    engine.queue(first.promise, Promise.resolve(newerHunks));

    const oldRun = coordinator.externalChange(key, 'old-result');
    await coordinator.externalChange(key, 'new-result');
    first.resolve(olderHunks);
    await oldRun;

    expect(view.renders).toEqual([{ key, hunks: newerHunks }]);
  });

  it('rejects a result when the compared text no longer matches stored state', async () => {
    const { coordinator, engine, store, view } = setup();
    const result = deferred<readonly ChangeHunk[]>();
    coordinator.seed(key, 'baseline');
    view.visible.add(key);
    engine.queue(result.promise);

    const run = coordinator.externalChange(key, 'old-result');
    const pending = store.get(key)!;
    store.setComparison(key, { ...pending, currentText: 'changed-elsewhere' });
    result.resolve(olderHunks);
    await run;

    expect(store.get(key)?.currentText).toBe('changed-elsewhere');
    expect(view.renders).toEqual([]);
  });

  it('approves one hunk by advancing only that baseline section', async () => {
    const { coordinator, engine, store } = setup();
    const firstHunk: ChangeHunk = {
      kind: 'modification',
      originalStart: 0,
      originalEnd: 1,
      modifiedStart: 0,
      modifiedEnd: 1,
      originalLines: ['alpha'],
      modifiedLines: ['ALPHA'],
    };
    const secondHunk: ChangeHunk = {
      kind: 'modification',
      originalStart: 2,
      originalEnd: 3,
      modifiedStart: 2,
      modifiedEnd: 3,
      originalLines: ['gamma'],
      modifiedLines: ['GAMMA'],
    };
    const remainingHunk: ChangeHunk = {
      ...secondHunk,
      originalLines: ['gamma'],
    };
    coordinator.seed(key, 'alpha\nbeta\ngamma\n');
    engine.queue([firstHunk, secondHunk], [remainingHunk]);
    await coordinator.externalChange(key, 'ALPHA\nbeta\nGAMMA\n');
    const state = store.get(key)!;
    const reference: HunkReference = {
      key,
      sourceRevision: state.sourceRevision,
      hunkIndex: 0,
      expectedText: state.currentText,
    };

    expect(await coordinator.approveHunk(reference)).toBe('approved');
    expect(engine.calls).toEqual([
      { original: 'alpha\nbeta\ngamma\n', modified: 'ALPHA\nbeta\nGAMMA\n' },
      { original: 'ALPHA\nbeta\ngamma\n', modified: 'ALPHA\nbeta\nGAMMA\n' },
    ]);
    expect(store.get(key)).toMatchObject({
      baselineText: 'ALPHA\nbeta\ngamma\n',
      currentText: 'ALPHA\nbeta\nGAMMA\n',
      hunks: [remainingHunk],
      comparisonActive: true,
      pending: true,
      createdFile: false,
    });
  });

  it('clears the comparison view when approving the final hunk', async () => {
    const { coordinator, engine, store, view } = setup();
    const finalHunk: ChangeHunk = {
      kind: 'modification',
      originalStart: 0,
      originalEnd: 1,
      modifiedStart: 0,
      modifiedEnd: 1,
      originalLines: ['before'],
      modifiedLines: ['after'],
    };
    coordinator.seed(key, 'before\n');
    engine.queue([finalHunk], []);
    await coordinator.externalChange(key, 'after\n');
    const state = store.get(key)!;
    const reference: HunkReference = {
      key,
      sourceRevision: state.sourceRevision,
      hunkIndex: 0,
      expectedText: state.currentText,
    };

    expect(await coordinator.approveHunk(reference)).toBe('approved');
    expect(store.get(key)).toMatchObject({
      baselineText: 'after\n',
      currentText: 'after\n',
      hunks: [],
      comparisonActive: false,
      pending: false,
      createdFile: false,
    });
    expect(view.clear).toHaveBeenCalledWith(key);
  });

  it('clears a generated EOF-newline hunk after one approval and keeps a repeated command stale', async () => {
    const store = new SnapshotStore();
    const view = new FakeView();
    const coordinator = new ComparisonCoordinator(new LineDiffEngine(), store, view);
    await coordinator.externalCreate(key, 'x\n');
    const state = store.get(key)!;
    const hunkReference: HunkReference = {
      key,
      sourceRevision: state.sourceRevision,
      hunkIndex: 0,
      expectedText: state.currentText,
    };

    expect(await coordinator.approveHunk(hunkReference)).toBe('approved');
    expect(store.get(key)).toMatchObject({
      baselineText: 'x\n',
      currentText: 'x\n',
      hunks: [],
      comparisonActive: false,
      pending: false,
      createdFile: false,
    });
    expect(await coordinator.approveHunk(hunkReference)).toBe('stale');
  });

  it('returns stale when an approval re-diff is superseded before it resolves', async () => {
    const { coordinator, engine, store, view } = setup();
    const reDiff = deferred<readonly ChangeHunk[]>();
    coordinator.seed(key, 'before\n');
    const seeded = store.get(key)!;
    store.setComparison(key, {
      ...seeded,
      currentText: 'after\n',
      hunks: [{
        kind: 'modification',
        originalStart: 0,
        originalEnd: 1,
        modifiedStart: 0,
        modifiedEnd: 1,
        originalLines: ['before'],
        modifiedLines: ['after'],
      }],
      comparisonActive: true,
      pending: true,
    });
    const state = store.get(key)!;
    engine.queue(reDiff.promise);

    const approval = coordinator.approveHunk({
      key,
      sourceRevision: state.sourceRevision,
      hunkIndex: 0,
      expectedText: state.currentText,
    });
    expect(coordinator.approveAll(key, 'after\n')).toBe('approved');
    reDiff.resolve([]);

    await expect(approval).resolves.toBe('stale');
    expect(store.get(key)).toMatchObject({
      baselineText: 'after\n',
      currentText: 'after\n',
      hunks: [],
      comparisonActive: false,
      pending: false,
    });
    expect(view.renderStarts).toEqual([]);
  });

  it('returns stale and clears delayed approval rendering after a newer approval wins', async () => {
    const { coordinator, engine, store, view } = setup();
    const render = deferred<void>();
    const firstHunk: ChangeHunk = {
      kind: 'modification',
      originalStart: 0,
      originalEnd: 1,
      modifiedStart: 0,
      modifiedEnd: 1,
      originalLines: ['alpha'],
      modifiedLines: ['ALPHA'],
    };
    const remainingHunk: ChangeHunk = {
      kind: 'modification',
      originalStart: 2,
      originalEnd: 3,
      modifiedStart: 2,
      modifiedEnd: 3,
      originalLines: ['gamma'],
      modifiedLines: ['GAMMA'],
    };
    coordinator.seed(key, 'alpha\nbeta\ngamma\n');
    const seeded = store.get(key)!;
    store.setComparison(key, {
      ...seeded,
      currentText: 'ALPHA\nbeta\nGAMMA\n',
      hunks: [firstHunk, remainingHunk],
      comparisonActive: true,
      pending: true,
    });
    const state = store.get(key)!;
    view.visible.add(key);
    view.queueRender(render.promise);
    engine.queue([remainingHunk]);

    const approval = coordinator.approveHunk({
      key,
      sourceRevision: state.sourceRevision,
      hunkIndex: 0,
      expectedText: state.currentText,
    });
    await Promise.resolve();
    expect(view.renderStarts).toEqual([{ key, hunks: [remainingHunk] }]);

    expect(coordinator.approveAll(key, 'ALPHA\nbeta\nGAMMA\n')).toBe('approved');
    render.resolve();

    await expect(approval).resolves.toBe('stale');
    expect(view.renderedHunks.get(key)).toBeUndefined();
  });

  it('retains created-file origin while a partial approval is re-diffing', async () => {
    const { coordinator, engine, store } = setup();
    const reDiff = deferred<readonly ChangeHunk[]>();
    const firstHunk: ChangeHunk = {
      kind: 'addition',
      originalStart: 0,
      originalEnd: 0,
      modifiedStart: 0,
      modifiedEnd: 1,
      originalLines: [],
      modifiedLines: ['one'],
    };
    const remainingHunk: ChangeHunk = {
      kind: 'addition',
      originalStart: 1,
      originalEnd: 1,
      modifiedStart: 1,
      modifiedEnd: 2,
      originalLines: [],
      modifiedLines: ['two'],
    };
    engine.queue([firstHunk, remainingHunk], reDiff.promise);
    await coordinator.externalCreate(key, 'one\ntwo\n');
    const state = store.get(key)!;

    const approval = coordinator.approveHunk({
      key,
      sourceRevision: state.sourceRevision,
      hunkIndex: 0,
      expectedText: state.currentText,
    });
    expect(store.get(key)?.createdFile).toBe(true);
    reDiff.resolve([remainingHunk]);

    await expect(approval).resolves.toBe('approved');
    expect(store.get(key)).toMatchObject({
      hunks: [remainingHunk],
      createdFile: true,
    });
  });

  it('accepts all current text without writing through a callback', () => {
    const { coordinator, engine, store, view } = setup();
    coordinator.seed(key, 'before');
    const state = store.get(key)!;
    store.setComparison(key, { ...state, currentText: 'after', hunks: newerHunks, comparisonActive: true, pending: true });
    expect(coordinator.approveAll(key, 'after')).toBe('approved');
    expect(engine.calls).toEqual([]);
    expect(store.get(key)).toMatchObject({
      baselineText: 'after',
      currentText: 'after',
      hunks: [],
      comparisonActive: false,
      pending: false,
      createdFile: false,
    });
    expect(view.clear).toHaveBeenCalledWith(key);
  });

  it('rejects missing or stale hunk references before applying a patch', () => {
    const { coordinator, store } = setup();
    expect(coordinator.state(key)).toBeUndefined();
    expect(coordinator.resolveHunk({
      key,
      sourceRevision: 1,
      hunkIndex: 0,
      expectedText: 'after',
    })).toEqual({ status: 'missing' });

    coordinator.seed(key, 'before');
    const seeded = store.get(key)!;
    store.setComparison(key, { ...seeded, currentText: 'after', hunks: newerHunks, comparisonActive: true, pending: true });
    const current = store.get(key)!;
    expect(coordinator.resolveHunk({
      key,
      sourceRevision: current.sourceRevision - 1,
      hunkIndex: 0,
      expectedText: current.currentText,
    })).toEqual({ status: 'stale' });
    expect(coordinator.resolveHunk({
      key,
      sourceRevision: current.sourceRevision,
      hunkIndex: current.hunks.length,
      expectedText: current.currentText,
    })).toEqual({ status: 'stale' });
    expect(coordinator.resolveHunk({
      key,
      sourceRevision: current.sourceRevision,
      hunkIndex: 0,
      expectedText: 'changed elsewhere',
    })).toEqual({ status: 'stale' });
  });

  it('disposes pending work, rejects in-flight results, and clears all rendering', async () => {
    vi.useFakeTimers();
    try {
      const { coordinator, debouncer, engine, store, view } = setup();
      const result = deferred<readonly ChangeHunk[]>();
      const pending = vi.fn();
      coordinator.seed(key, 'baseline');
      view.visible.add(key);
      engine.queue(result.promise);
      debouncer.schedule(key, 100, pending);
      const run = coordinator.externalChange(key, 'new-result');

      coordinator.dispose();
      vi.advanceTimersByTime(100);
      result.resolve(newerHunks);
      await run;

      expect(pending).not.toHaveBeenCalled();
      expect(store.get(key)).toBeUndefined();
      expect(view.renders).toEqual([]);
      expect(view.clearAll).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
