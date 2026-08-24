import { describe, expect, it } from 'vitest';
import { LineDiffEngine } from '../../src/diffEngine';
import { applyApprovedHunk, rejectedHunkReplacement } from '../../src/reviewText';
import type { ChangeHunk } from '../../src/types';

function hunk(overrides: Partial<ChangeHunk>): ChangeHunk {
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

function applyReplacement(text: string, replacement: ReturnType<typeof rejectedHunkReplacement>): string {
  return text.slice(0, replacement.startOffset)
    + replacement.replacementText
    + text.slice(replacement.endOffset);
}

describe('applyApprovedHunk', () => {
  it('approves a line addition while retaining LF and the final newline', () => {
    expect(applyApprovedHunk('a\n', hunk({
      kind: 'addition',
      originalStart: 1,
      originalEnd: 1,
      modifiedStart: 1,
      modifiedEnd: 2,
      modifiedLines: ['b'],
    }))).toBe('a\nb\n');
  });

  it('approves a deletion without changing LF structure', () => {
    expect(applyApprovedHunk('a\nb\n', hunk({
      kind: 'deletion',
      originalStart: 1,
      originalEnd: 2,
      modifiedStart: 1,
      modifiedEnd: 1,
      originalLines: ['b'],
    }))).toBe('a\n');
  });

  it('approves a modification without changing CRLF or final newline', () => {
    const change = hunk({
      kind: 'modification',
      originalStart: 1,
      originalEnd: 2,
      modifiedStart: 1,
      modifiedEnd: 2,
      originalLines: ['old'],
      modifiedLines: ['new'],
    });

    expect(applyApprovedHunk('a\r\nold\r\nz\r\n', change))
      .toBe('a\r\nnew\r\nz\r\n');
  });

  it('approves a first-line modification', () => {
    expect(applyApprovedHunk('old\nrest\n', hunk({
      kind: 'modification',
      originalStart: 0,
      originalEnd: 1,
      modifiedStart: 0,
      modifiedEnd: 1,
      originalLines: ['old'],
      modifiedLines: ['new'],
    }))).toBe('new\nrest\n');
  });

  it('approves an EOF modification without adding a final newline', () => {
    expect(applyApprovedHunk('a\nold', hunk({
      kind: 'modification',
      originalStart: 1,
      originalEnd: 2,
      modifiedStart: 1,
      modifiedEnd: 2,
      originalLines: ['old'],
      modifiedLines: ['new'],
    }))).toBe('a\nnew');
  });

  it('approves an addition to an empty file without inventing a final newline', () => {
    expect(applyApprovedHunk('', hunk({
      kind: 'addition',
      originalStart: 0,
      originalEnd: 0,
      modifiedStart: 0,
      modifiedEnd: 1,
      modifiedLines: ['only'],
    }))).toBe('only');
  });

  it('approves a change to a blank final line', () => {
    expect(applyApprovedHunk('a\n\n', hunk({
      kind: 'modification',
      originalStart: 1,
      originalEnd: 2,
      modifiedStart: 1,
      modifiedEnd: 2,
      originalLines: [''],
      modifiedLines: ['x'],
    }))).toBe('a\nx\n');
  });

  it('approves an insertion before an unterminated EOF line', () => {
    expect(applyApprovedHunk('a\nb', hunk({
      kind: 'addition',
      originalStart: 1,
      originalEnd: 1,
      modifiedStart: 1,
      modifiedEnd: 2,
      modifiedLines: ['x'],
    }))).toBe('a\nx\nb');
  });

  it('approves an insertion after an unterminated EOF line', () => {
    expect(applyApprovedHunk('a', hunk({
      kind: 'addition',
      originalStart: 1,
      originalEnd: 1,
      modifiedStart: 1,
      modifiedEnd: 2,
      modifiedLines: ['b'],
    }))).toBe('a\nb');
  });
});

describe('rejectedHunkReplacement', () => {
  it('deletes an added LF line using an end-exclusive UTF-16 range', () => {
    const change = hunk({
      kind: 'addition',
      originalStart: 1,
      originalEnd: 1,
      modifiedStart: 1,
      modifiedEnd: 2,
      modifiedLines: ['new'],
    });

    expect(rejectedHunkReplacement('a\nnew\nz\n', change)).toEqual({
      startOffset: 2,
      endOffset: 6,
      replacementText: '',
    });
  });

  it('inserts deleted original lines at the modified LF line boundary', () => {
    const change = hunk({
      kind: 'deletion',
      originalStart: 1,
      originalEnd: 2,
      modifiedStart: 1,
      modifiedEnd: 1,
      originalLines: ['old'],
    });

    expect(rejectedHunkReplacement('a\nz\n', change)).toEqual({
      startOffset: 2,
      endOffset: 2,
      replacementText: 'old\n',
    });
  });

  it('replaces a modified LF line with the original text', () => {
    const change = hunk({
      kind: 'modification',
      originalStart: 1,
      originalEnd: 2,
      modifiedStart: 1,
      modifiedEnd: 2,
      originalLines: ['old'],
      modifiedLines: ['new'],
    });

    expect(rejectedHunkReplacement('a\nnew\nz\n', change)).toEqual({
      startOffset: 2,
      endOffset: 6,
      replacementText: 'old\n',
    });
  });

  it('uses CRLF in a replacement and preserves an unterminated EOF line', () => {
    const change = hunk({
      kind: 'modification',
      originalStart: 1,
      originalEnd: 2,
      modifiedStart: 1,
      modifiedEnd: 2,
      originalLines: ['old'],
      modifiedLines: ['new'],
    });

    expect(rejectedHunkReplacement('a\r\nnew', change)).toEqual({
      startOffset: 3,
      endOffset: 6,
      replacementText: 'old',
    });
  });

  it('counts UTF-16 code units when locating a rejected line', () => {
    const change = hunk({
      kind: 'modification',
      originalStart: 1,
      originalEnd: 2,
      modifiedStart: 1,
      modifiedEnd: 2,
      originalLines: ['old'],
      modifiedLines: ['new'],
    });

    expect(rejectedHunkReplacement('😀\nnew\nz\n', change)).toEqual({
      startOffset: 3,
      endOffset: 7,
      replacementText: 'old\n',
    });
  });

  it('returns an EOF insertion replacement at the end of the current text', () => {
    const change = hunk({
      kind: 'deletion',
      originalStart: 1,
      originalEnd: 2,
      modifiedStart: 1,
      modifiedEnd: 1,
      originalLines: ['old'],
    });

    expect(rejectedHunkReplacement('a\n', change)).toEqual({
      startOffset: 2,
      endOffset: 2,
      replacementText: 'old\n',
    });
  });
});

describe('real diff EOF round trips', () => {
  const engine = new LineDiffEngine();
  const cases = [
    { name: 'empty to LF-terminated content', original: '', modified: 'x\n' },
    { name: 'LF-terminated content to empty', original: 'x\n', modified: '' },
    { name: 'content gaining a final LF', original: 'x', modified: 'x\n' },
    { name: 'content losing its final LF', original: 'x\n', modified: 'x' },
    { name: 'changed EOF content gaining a final LF', original: 'old', modified: 'new\n' },
    { name: 'changed EOF content losing its final LF', original: 'old\n', modified: 'new' },
    { name: 'empty to CRLF-terminated content', original: '', modified: 'x\r\n' },
    { name: 'CRLF-terminated content to empty', original: 'x\r\n', modified: '' },
    { name: 'changed EOF content gaining a final CRLF', original: 'old', modified: 'new\r\n' },
    { name: 'changed EOF content losing its final CRLF', original: 'old\r\n', modified: 'new' },
  ];

  for (const testCase of cases) {
    it(`approves and rejects ${testCase.name} exactly`, () => {
      const hunks = engine.compute(testCase.original, testCase.modified);

      expect(hunks).toHaveLength(1);
      expect(applyApprovedHunk(testCase.original, hunks[0])).toBe(testCase.modified);
      expect(applyReplacement(
        testCase.modified,
        rejectedHunkReplacement(testCase.modified, hunks[0]),
      )).toBe(testCase.original);
    });
  }
});
