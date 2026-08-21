import { describe, expect, it, vi } from 'vitest';
import { PerKeyDebouncer } from '../../src/changePolicy';
import { ComparisonCoordinator, ComparisonView } from '../../src/coordinator';
import { SnapshotStore } from '../../src/snapshotStore';
import type { ChangeHunk } from '../../src/types';

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
  readonly clear = vi.fn<(key: string) => void>();
  readonly clearAll = vi.fn<() => void>();

  async render(key: string, hunks: readonly ChangeHunk[]): Promise<void> {
    if (this.visible.has(key)) {
      this.renders.push({ key, hunks });
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

  it('seeds unseen external content without diffing or rendering', async () => {
    const { coordinator, engine, store, view } = setup();

    await coordinator.externalChange(key, 'baseline');

    expect(store.get(key)).toMatchObject({
      baselineText: 'baseline',
      currentText: 'baseline',
      hunks: [],
      pending: false,
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
      pending: true,
    });

    coordinator.save(key, 'saved');

    expect(store.get(key)).toMatchObject({
      baselineText: 'saved',
      currentText: 'saved',
      hunks: [],
      pending: false,
    });
    expect(view.clear).toHaveBeenCalledWith(key);
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
