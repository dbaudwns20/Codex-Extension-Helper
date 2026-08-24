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
    lineAt: (line: number) => ({ range: { end: { character: line + 3 } } }),
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

  it('places approve and reject at the configured spacer action line', () => {
    const { provider } = createProvider();
    provider.update(state({ hunks: [hunk({
      kind: 'modification',
      modifiedStart: 2,
      originalLines: ['const value = 1;'],
      modifiedLines: ['const value = 2;'],
    })], actionLines: [3] }));

    const lenses = provide(provider);

    expect(lenses.map((lens) => lens.command?.command)).toEqual([
      'codexExtensionHelper.approveHunk',
      'codexExtensionHelper.rejectHunk',
    ]);
    expect(lenses.map((lens) => lens.range)).toEqual([
      new FakeRange(3, 6, 3, 6),
      new FakeRange(3, 6, 3, 6),
    ]);
    expect(lenses[0].command?.arguments).toEqual([{
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
      'codexExtensionHelper.approveHunk',
      'codexExtensionHelper.rejectHunk',
    ]);
    expect(lenses[0].command?.arguments).toEqual([expect.objectContaining({ hunkIndex: 0 })]);
    expect(lenses[1].command?.arguments).toEqual(lenses[0].command?.arguments);
    expect(lenses[2].command?.arguments).toEqual([expect.objectContaining({
      key,
      sourceRevision: 7,
      hunkIndex: 1,
      expectedText: 'new\nother\n',
    })]);
    expect(lenses[3].command?.arguments).toEqual(lenses[2].command?.arguments);
  });

  it('keeps legacy updates summary-only and does not show legacy additions', () => {
    const { provider } = createProvider();
    provider.update(key, [
      hunk({ originalLines: ['old'], modifiedStart: 2 }),
      hunk({ modifiedStart: 3 }),
    ]);

    const lenses = provide(provider);

    expect(lenses.map((lens) => lens.command?.command)).toEqual([
      'codexExtensionHelper.openDiff',
    ]);
    expect(lenses[0].command?.arguments).toBeUndefined();

    provider.update(key, [hunk({ modifiedLines: ['only addition'] })]);
    expect(provide(provider)).toEqual([]);
  });

  it('clamps negative modified starts to the first document line', () => {
    const { provider } = createProvider();
    provider.update(state({ hunks: [hunk({ modifiedStart: -4, originalLines: ['old'] })] }));

    const [approve] = provide(provider, 5);

    expect(approve.range).toEqual(new FakeRange(0, 3, 0, 3));
  });

  it('clamps past-end modified starts to the final document line', () => {
    const { provider } = createProvider();
    provider.update(state({ hunks: [hunk({ modifiedStart: 99, originalLines: ['old'] })] }));

    const [approve] = provide(provider, 5);

    expect(approve.range).toEqual(new FakeRange(4, 7, 4, 7));
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
