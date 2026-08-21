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
    }]);
  });

  it('returns no hunks for unchanged input', () => {
    expect(engine.compute('same\ncontent\n', 'same\ncontent\n')).toEqual([]);
  });

  it('normalizes line endings without creating a hunk', () => {
    expect(engine.compute('a\r\nb\r\n', 'a\nb\n')).toEqual([]);
  });
});
