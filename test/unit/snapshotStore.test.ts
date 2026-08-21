import { describe, expect, it } from 'vitest';
import { SnapshotStore } from '../../src/snapshotStore';

describe('SnapshotStore', () => {
  it('keeps baselines independent for separate URI keys', () => {
    const store = new SnapshotStore();
    store.seed('file:///workspace/first.ts', 'first');
    store.seed('file:///workspace/second.ts', 'second');

    expect(store.get('file:///workspace/first.ts')?.baselineText).toBe('first');
    expect(store.get('file:///workspace/second.ts')?.baselineText).toBe('second');
  });

  it('persists a comparison state for a key', () => {
    const store = new SnapshotStore();
    const state = {
      baselineText: 'before',
      currentText: 'after',
      hunks: [],
      sourceRevision: 4,
      pending: true,
    };

    store.setComparison('file:///workspace/file.ts', state);

    expect(store.get('file:///workspace/file.ts')).toEqual(state);
  });

  it('accepts saved text as the new baseline and clears comparison hunks', () => {
    const store = new SnapshotStore();
    const key = 'file:///workspace/file.ts';
    store.setComparison(key, {
      baselineText: 'before',
      currentText: 'after',
      hunks: [{
        kind: 'modification',
        originalStart: 0,
        originalEnd: 1,
        modifiedStart: 0,
        modifiedEnd: 1,
        originalLines: ['before'],
        modifiedLines: ['after'],
      }],
      sourceRevision: 4,
      pending: true,
    });

    store.accept(key, 'saved');

    expect(store.get(key)).toMatchObject({
      baselineText: 'saved',
      currentText: 'saved',
      hunks: [],
      pending: false,
    });
  });

  it('removes one state with delete and every state with clear', () => {
    const store = new SnapshotStore();
    const first = 'file:///workspace/first.ts';
    const second = 'file:///workspace/second.ts';
    store.seed(first, 'first');
    store.seed(second, 'second');

    store.delete(first);
    expect(store.get(first)).toBeUndefined();
    expect(store.get(second)).toBeDefined();

    store.clear();
    expect(store.get(second)).toBeUndefined();
  });
});
