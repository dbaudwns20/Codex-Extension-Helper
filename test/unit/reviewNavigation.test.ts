import { describe, expect, it } from 'vitest';
import { reviewAnchor, targetReviewIndex } from '../../src/reviewNavigation';
import type { ChangeHunk } from '../../src/types';

function hunk(overrides: Partial<ChangeHunk> = {}): ChangeHunk {
  return {
    kind: 'modification',
    originalStart: 0,
    originalEnd: 0,
    modifiedStart: 0,
    modifiedEnd: 0,
    originalLines: [],
    modifiedLines: [],
    ...overrides,
  };
}

describe('reviewAnchor', () => {
  it('uses the modified start, including for deletion hunks', () => {
    expect(reviewAnchor(hunk({ modifiedStart: 7, modifiedEnd: 7, kind: 'deletion' }))).toBe(7);
  });
});

describe('targetReviewIndex', () => {
  const hunks = [
    hunk({ modifiedStart: 2 }),
    hunk({ modifiedStart: 6 }),
    hunk({ modifiedStart: 10 }),
  ];

  it('returns undefined when there are no hunks', () => {
    expect(targetReviewIndex([], 4, 'next')).toBeUndefined();
    expect(targetReviewIndex([], 4, 'previous')).toBeUndefined();
  });

  it('selects the first following anchor for Next from before or between hunks', () => {
    expect(targetReviewIndex(hunks, 0, 'next')).toBe(0);
    expect(targetReviewIndex(hunks, 6, 'next')).toBe(2);
  });

  it('selects the last preceding anchor for Previous from between or after hunks', () => {
    expect(targetReviewIndex(hunks, 8, 'previous')).toBe(1);
    expect(targetReviewIndex(hunks, 99, 'previous')).toBe(2);
  });

  it('moves past an exact anchor in the requested direction', () => {
    expect(targetReviewIndex(hunks, 6, 'next')).toBe(2);
    expect(targetReviewIndex(hunks, 6, 'previous')).toBe(0);
  });

  it('wraps Next to the first hunk and Previous to the final hunk', () => {
    expect(targetReviewIndex(hunks, 10, 'next')).toBe(0);
    expect(targetReviewIndex(hunks, 2, 'previous')).toBe(2);
  });

  it('follows hunk array order rather than sorting by anchor', () => {
    const ordered = [hunk({ modifiedStart: 10 }), hunk({ modifiedStart: 2 }), hunk({ modifiedStart: 6 })];

    expect(targetReviewIndex(ordered, 3, 'next')).toBe(0);
    expect(targetReviewIndex(ordered, 3, 'previous')).toBe(1);
  });
});
