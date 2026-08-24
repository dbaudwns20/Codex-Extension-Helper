import { describe, expect, it, vi } from 'vitest';
import { DeletedLinesCodeLensProvider, type ReviewCodeLensState } from '../../src/deletedLinesCodeLensProvider';
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

type Lens = {
  range: FakeRange;
  command?: {
    title: string;
    command: string;
    tooltip?: string;
    arguments?: readonly unknown[];
  };
};

const key = 'file:///workspace/file.ts';

function hunk(overrides: Partial<ChangeHunk>): ChangeHunk {
  return {
    kind: 'addition',
    originalStart: 0,
    originalEnd: 0,
    modifiedStart: 0,
    modifiedEnd: 1,
    originalLines: [],
    modifiedLines: ['new'],
    ...overrides,
  };
}

function state(overrides: Partial<ReviewCodeLensState>): ReviewCodeLensState {
  return {
    key,
    sourceRevision: 7,
    currentText: 'new\n',
    hunks: [],
    ...overrides,
  };
}

function createProvider() {
  const registration = { dispose: vi.fn() };
  const emitter = new FakeEventEmitter();
  const provider = new DeletedLinesCodeLensProvider({
    languages: { registerCodeLensProvider: vi.fn(() => registration) },
    EventEmitter: vi.fn(() => emitter) as unknown as typeof FakeEventEmitter,
    Range: FakeRange,
    CodeLens: FakeCodeLens,
  } as never, (uri: { toString(): string }) => uri.toString());
  return { provider, emitter, registration };
}

function provide(provider: DeletedLinesCodeLensProvider, lineCount = 5): Lens[] {
  return provider.provideCodeLenses({
    uri: { toString: () => key },
    lineCount,
  } as never) as unknown as Lens[];
}

describe('DeletedLinesCodeLensProvider', () => {
  it('emits approve and reject lenses for an addition-only hunk', () => {
    const { provider } = createProvider();
    provider.update(state({ hunks: [hunk({ modifiedLines: ['new'] })] }));

    const lenses = provide(provider);

    expect(lenses.map((lens) => lens.command?.command)).toEqual([
      'codexExtensionHelper.approveHunk',
      'codexExtensionHelper.rejectHunk',
    ]);
    expect(lenses.map((lens) => lens.command?.title)).toEqual([
      '$(check) Approve',
      '$(close) Reject',
    ]);
    expect(lenses[0].command?.arguments).toEqual([{
      key,
      sourceRevision: 7,
      hunkIndex: 0,
      expectedText: 'new\n',
    }]);
    expect(lenses[1].command?.arguments).toEqual(lenses[0].command?.arguments);
    expect(lenses[0].command?.arguments?.[0]).toBe(lenses[1].command?.arguments?.[0]);
  });

  it('places a deleted summary before approve and reject at the same anchor', () => {
    const { provider } = createProvider();
    provider.update(state({ hunks: [hunk({
      kind: 'modification',
      modifiedStart: 2,
      originalLines: ['const value = 1;'],
      modifiedLines: ['const value = 2;'],
    })] }));

    const lenses = provide(provider);

    expect(lenses.map((lens) => lens.command?.command)).toEqual([
      'codexExtensionHelper.openDiff',
      'codexExtensionHelper.approveHunk',
      'codexExtensionHelper.rejectHunk',
    ]);
    expect(lenses.map((lens) => lens.range)).toEqual([
      new FakeRange(2, 0, 2, 0),
      new FakeRange(2, 0, 2, 0),
      new FakeRange(2, 0, 2, 0),
    ]);
    expect(lenses[0].command).toEqual({
      title: '− const value = 1;',
      command: 'codexExtensionHelper.openDiff',
      tooltip: 'Deleted 1 line\n\nconst value = 1;',
    });
    expect(lenses[1].command?.arguments).toEqual([{
      key,
      sourceRevision: 7,
      hunkIndex: 0,
      expectedText: 'new\n',
    }]);
  });

  it('preserves hunk order and uses each hunk index in action references', () => {
    const { provider } = createProvider();
    provider.update(state({ currentText: 'new\nother\n', hunks: [
      hunk({ modifiedStart: 0, modifiedLines: ['new'] }),
      hunk({ modifiedStart: 4, originalLines: ['old'], modifiedLines: ['other'] }),
    ] }));

    const lenses = provide(provider, 8);

    expect(lenses.map((lens) => lens.command?.command)).toEqual([
      'codexExtensionHelper.approveHunk',
      'codexExtensionHelper.rejectHunk',
      'codexExtensionHelper.openDiff',
      'codexExtensionHelper.approveHunk',
      'codexExtensionHelper.rejectHunk',
    ]);
    expect(lenses[0].command?.arguments).toEqual([expect.objectContaining({ hunkIndex: 0 })]);
    expect(lenses[1].command?.arguments).toEqual(lenses[0].command?.arguments);
    expect(lenses[3].command?.arguments).toEqual([expect.objectContaining({
      key,
      sourceRevision: 7,
      hunkIndex: 1,
      expectedText: 'new\nother\n',
    })]);
    expect(lenses[4].command?.arguments).toEqual(lenses[3].command?.arguments);
  });

  it('retains preview truncation and labels a deleted blank line', () => {
    const { provider } = createProvider();
    const longLine = 'x'.repeat(121);
    provider.update(state({ hunks: [
      hunk({ originalLines: [longLine] }),
      hunk({ modifiedStart: 1, originalLines: [''] }),
    ] }));

    const lenses = provide(provider, 5);

    expect(lenses[0].command?.title).toBe(`− ${'x'.repeat(119)}…`);
    expect(lenses[3].command?.title).toBe('− (blank line)');
  });

  it('summarizes multiline deletion without changing the full-diff action', () => {
    const { provider } = createProvider();
    provider.update(state({ hunks: [hunk({ originalLines: ['first', 'second'] })] }));

    const [summary] = provide(provider);

    expect(summary.command).toEqual({
      title: '− 2 deleted lines',
      command: 'codexExtensionHelper.openDiff',
      tooltip: 'Deleted 2 lines\n\nfirst\nsecond',
    });
    expect(summary.command?.arguments).toBeUndefined();
  });

  it('clears lenses and disposes its resources', () => {
    const { provider, emitter, registration } = createProvider();
    provider.update(state({ hunks: [hunk({})] }));
    provider.clear(key);
    expect(provide(provider)).toEqual([]);
    provider.clear(key);
    provider.dispose();

    expect(emitter.fire).toHaveBeenCalledTimes(2);
    expect(registration.dispose).toHaveBeenCalledTimes(1);
    expect(emitter.dispose).toHaveBeenCalledTimes(1);
    expect(provide(provider)).toEqual([]);
  });
});
