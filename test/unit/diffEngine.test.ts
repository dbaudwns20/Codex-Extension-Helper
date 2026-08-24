import { describe, expect, it } from 'vitest';
import { LineDiffEngine } from '../../src/diffEngine';

describe('LineDiffEngine', () => {
  const engine = new LineDiffEngine();

  it('reports a pure addition at the insertion point', () => {
    expect(engine.compute('a\n', 'a\nb\n')).toEqual([{
      kind: 'addition',
      originalStart: 1,
      originalEnd: 1,
      modifiedStart: 1,
      modifiedEnd: 2,
      originalLines: [],
      modifiedLines: ['b'],
      originalEofTerminator: '\n',
      modifiedEofTerminator: '\n',
    }]);
  });

  it('reports a pure deletion at the removal point', () => {
    expect(engine.compute('a\nb\n', 'a\n')).toEqual([{
      kind: 'deletion',
      originalStart: 1,
      originalEnd: 2,
      modifiedStart: 1,
      modifiedEnd: 1,
      originalLines: ['b'],
      modifiedLines: [],
      originalEofTerminator: '\n',
      modifiedEofTerminator: '\n',
    }]);
  });

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

  it('reports a replacement on the first line', () => {
    expect(engine.compute('old\nrest\n', 'new\nrest\n')).toEqual([{
      kind: 'modification',
      originalStart: 0,
      originalEnd: 1,
      modifiedStart: 0,
      modifiedEnd: 1,
      originalLines: ['old'],
      modifiedLines: ['new'],
    }]);
  });

  it('reports deletion of the final content line', () => {
    expect(engine.compute('first\nlast\n', 'first\n')).toEqual([{
      kind: 'deletion',
      originalStart: 1,
      originalEnd: 2,
      modifiedStart: 1,
      modifiedEnd: 1,
      originalLines: ['last'],
      modifiedLines: [],
      originalEofTerminator: '\n',
      modifiedEofTerminator: '\n',
    }]);
  });

  it('reports the content added to an empty file', () => {
    expect(engine.compute('', 'only\n')).toEqual([{
      kind: 'addition',
      originalStart: 0,
      originalEnd: 0,
      modifiedStart: 0,
      modifiedEnd: 1,
      originalLines: [],
      modifiedLines: ['only'],
      originalEofTerminator: '',
      modifiedEofTerminator: '\n',
    }]);
  });

  it('retains a change when only the final newline is missing', () => {
    expect(engine.compute('a\nb\n', 'a\nb')).toEqual([{
      kind: 'modification',
      originalStart: 1,
      originalEnd: 2,
      modifiedStart: 1,
      modifiedEnd: 2,
      originalLines: ['b'],
      modifiedLines: ['b'],
      originalEofTerminator: '\n',
      modifiedEofTerminator: '',
    }]);
  });

  it('preserves each side EOF terminator on a generated EOF hunk', () => {
    const cases = [
      { original: '', modified: 'x\r\n', originalEofTerminator: '', modifiedEofTerminator: '\r\n' },
      { original: 'x\r\n', modified: '', originalEofTerminator: '\r\n', modifiedEofTerminator: '' },
      { original: 'old\r\n', modified: 'new', originalEofTerminator: '\r\n', modifiedEofTerminator: '' },
      { original: 'old', modified: 'new\n', originalEofTerminator: '', modifiedEofTerminator: '\n' },
    ];

    for (const testCase of cases) {
      const hunks = engine.compute(testCase.original, testCase.modified);

      expect(hunks).toHaveLength(1);
      expect(hunks[0]).toMatchObject({
        originalEofTerminator: testCase.originalEofTerminator,
        modifiedEofTerminator: testCase.modifiedEofTerminator,
      });
    }
  });

  it('returns no hunks for unchanged input', () => {
    expect(engine.compute('same\ncontent\n', 'same\ncontent\n')).toEqual([]);
  });

  it('normalizes line endings without creating a hunk', () => {
    expect(engine.compute('a\r\nb\r\n', 'a\nb\n')).toEqual([]);
  });
});
