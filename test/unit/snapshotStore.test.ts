import { describe, expect, it } from 'vitest';
import { SnapshotStore } from '../../src/snapshotStore';

const provenance = {
  confidence: 'exact' as const,
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemIds: ['item-1'],
};

describe('SnapshotStore', () => {
  it('keeps baselines independent for separate URI keys', () => {
    const store = new SnapshotStore();
    store.seed('file:///workspace/first.ts', 'first');
    store.seed('file:///workspace/second.ts', 'second');

    expect(store.get('file:///workspace/first.ts')?.baselineText).toBe('first');
    expect(store.get('file:///workspace/second.ts')?.baselineText).toBe('second');
    expect(store.acceptedText('file:///workspace/first.ts')).toBe('first');
    expect(store.acceptedText('file:///workspace/second.ts')).toBe('second');
  });

  it('persists a comparison state for a key', () => {
    const store = new SnapshotStore();
    const state = {
      baselineText: 'before',
      currentText: 'after',
      hunks: [],
      sourceRevision: 4,
      comparisonActive: true,
      pending: true,
      lifecycle: 'existing' as const,
      provenance,
    };

    store.setComparison('file:///workspace/file.ts', state);

    expect(store.get('file:///workspace/file.ts')).toEqual(state);
    expect(store.acceptedText('file:///workspace/file.ts')).toBeUndefined();
  });

  it('preserves lifecycle and exact provenance on an explicit comparison state', () => {
    const store = new SnapshotStore();
    const state = {
      baselineText: '',
      currentText: 'created',
      hunks: [],
      sourceRevision: 4,
      comparisonActive: true,
      pending: true,
      lifecycle: 'created' as const,
      provenance,
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
      comparisonActive: true,
      pending: true,
      lifecycle: 'existing',
      provenance,
    });

    store.accept(key, 'saved');

    expect(store.acceptedText(key)).toBe('saved');
    expect(store.get(key)).toMatchObject({
      baselineText: 'saved',
      currentText: 'saved',
      hunks: [],
      comparisonActive: false,
      pending: false,
      lifecycle: 'existing',
      provenance: undefined,
    });
  });

  it('marks seeded and accepted states as clean existing files without provenance', () => {
    const store = new SnapshotStore();
    const key = 'file:///workspace/file.ts';

    store.seed(key, 'seeded');
    expect(store.get(key)).toMatchObject({ lifecycle: 'existing', provenance: undefined });

    store.accept(key, 'accepted');
    expect(store.get(key)).toMatchObject({
      baselineText: 'accepted',
      currentText: 'accepted',
      hunks: [],
      comparisonActive: false,
      pending: false,
      lifecycle: 'existing',
      provenance: undefined,
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
    expect(store.acceptedText(first)).toBeUndefined();
    expect(store.get(second)).toBeDefined();

    store.clear();
    expect(store.get(second)).toBeUndefined();
  });
});
