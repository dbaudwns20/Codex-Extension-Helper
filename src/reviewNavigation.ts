import type { ChangeHunk } from './types';

export type ReviewDirection = 'previous' | 'next';

export function reviewAnchor(hunk: ChangeHunk): number {
  return hunk.modifiedStart;
}

export function targetReviewIndex(
  hunks: readonly ChangeHunk[],
  cursorLine: number,
  direction: ReviewDirection,
): number | undefined {
  if (hunks.length === 0) {
    return undefined;
  }

  if (direction === 'next') {
    for (let index = 0; index < hunks.length; index += 1) {
      if (reviewAnchor(hunks[index]) > cursorLine) {
        return index;
      }
    }
    return 0;
  }

  for (let index = hunks.length - 1; index >= 0; index -= 1) {
    if (reviewAnchor(hunks[index]) < cursorLine) {
      return index;
    }
  }
  return hunks.length - 1;
}
