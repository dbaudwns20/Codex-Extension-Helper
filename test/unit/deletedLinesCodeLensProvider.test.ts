import { describe, expect, it, vi } from 'vitest';
import * as inlineRendererModule from '../../src/inlineRenderer';
import type { ChangeHunk } from '../../src/types';

class FakeRange {
  constructor(
    readonly startLine: number,
    readonly startCharacter: number,
    readonly endLine: number,
    readonly endCharacter: number,
  ) {}
}

class FakeCodeLens {
  constructor(readonly range: FakeRange, readonly command?: unknown) {}
}

class FakeEventEmitter {
  readonly event = vi.fn();
  readonly fire = vi.fn();
  readonly dispose = vi.fn();
}

describe('DeletedLinesCodeLensProvider', () => {
  it('places deleted text on a dedicated row above the modified line', () => {
    const Candidate = (inlineRendererModule as typeof inlineRendererModule & {
      DeletedLinesCodeLensProvider?: new (...args: never[]) => {
        update(key: string, hunks: readonly ChangeHunk[]): void;
        provideCodeLenses(document: unknown): Array<{ range: FakeRange; command?: { title: string; command: string; tooltip?: string } }>;
      };
    }).DeletedLinesCodeLensProvider;

    expect(typeof Candidate).toBe('function');
    if (Candidate === undefined) {
      return;
    }

    const provider = new Candidate({
      languages: { registerCodeLensProvider: vi.fn(() => ({ dispose: vi.fn() })) },
      EventEmitter: FakeEventEmitter,
      Range: FakeRange,
      CodeLens: FakeCodeLens,
    } as never, (uri: { toString(): string }) => uri.toString());
    const key = 'file:///workspace/file.ts';
    provider.update(key, [{
      kind: 'modification',
      originalStart: 2,
      originalEnd: 3,
      modifiedStart: 2,
      modifiedEnd: 3,
      originalLines: ['const value = 1;'],
      modifiedLines: ['const value = 2;'],
    }]);

    const lenses = provider.provideCodeLenses({
      uri: { toString: () => key },
      lineCount: 5,
    } as never);

    expect(lenses).toHaveLength(1);
    expect(lenses[0].range).toEqual(new FakeRange(2, 0, 2, 0));
    expect(lenses[0].command).toEqual({
      title: '− const value = 1;',
      command: 'codexExtensionHelper.openDiff',
      tooltip: 'Deleted 1 line\n\nconst value = 1;',
    });
  });
});
