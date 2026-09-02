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
  const registerCodeLensProvider = vi.fn(() => registration);
  const registerInlayHintsProvider = vi.fn(() => registration);
  const provider = new DeletedLinesCodeLensProvider({
    languages: {
      registerCodeLensProvider,
      registerInlayHintsProvider,
    },
    EventEmitter: vi.fn(() => emitter) as unknown as typeof FakeEventEmitter,
    Range: FakeRange,
    CodeLens: FakeCodeLens,
  } as never, (uri: { toString(): string }) => uri.toString());
  return { provider, emitter, registration, registerCodeLensProvider, registerInlayHintsProvider };
}

function provide(provider: DeletedLinesCodeLensProvider, lineCount = 5): Lens[] {
  return provider.provideCodeLenses({
    uri: { toString: () => key },
    lineCount,
    lineAt: (line: number) => ({ range: { end: { character: line + 3 } } }),
  } as never) as unknown as Lens[];
}

describe('DeletedLinesCodeLensProvider', () => {
  it('registers review actions as CodeLens controls above the changed line', () => {
    const { provider, registerCodeLensProvider, registerInlayHintsProvider } = createProvider();

    expect(registerCodeLensProvider).toHaveBeenCalledWith({ scheme: 'file' }, provider);
    expect(registerInlayHintsProvider).not.toHaveBeenCalled();
  });

  it('emits approve and reject lenses for an addition-only hunk', () => {
    const { provider } = createProvider();
    provider.update(state({ hunks: [hunk({ modifiedLines: ['new'] })] }));

    const lenses = provide(provider);

    expect(lenses.map((lens) => lens.command?.command)).toEqual([
      'codexExtensionHelper.approveHunk',
      'codexExtensionHelper.rejectHunk',
    ]);
    expect(lenses.map((lens) => lens.command?.title)).toEqual([
      '$(check) Accept',
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

  it('uses the same native review actions for a hunk containing deleted content', () => {
    const { provider } = createProvider();
    provider.update(state({ hunks: [hunk({
      kind: 'modification',
      modifiedStart: 2,
      originalLines: ['"version": "0.0.2",'],
      modifiedLines: ['"version": "0.0.3",'],
    })], actionLines: [3] }));

    const lenses = provide(provider);

    expect(lenses.map((lens) => lens.command?.title)).toEqual([
      '$(check) Accept',
      '$(close) Reject',
    ]);
    expect(lenses.map((lens) => lens.range)).toEqual([
      new FakeRange(3, 6, 3, 6),
      new FakeRange(3, 6, 3, 6),
    ]);
    expect(lenses.map((lens) => lens.command?.arguments?.[0])).toEqual([
      expect.objectContaining({ hunkIndex: 0 }),
      expect.objectContaining({ hunkIndex: 0 }),
    ]);
  });

  it('preserves hunk order when deletion and addition actions are mixed', () => {
    const { provider } = createProvider();
    provider.update(state({ hunks: [
      hunk({
        kind: 'deletion',
        originalEnd: 1,
        originalLines: ['old'],
        modifiedEnd: 0,
        modifiedLines: [],
      }),
      hunk({ modifiedStart: 3, modifiedEnd: 4, modifiedLines: ['added'] }),
    ] }));

    const lenses = provide(provider);

    expect(lenses).toHaveLength(4);
    expect(lenses.map((lens) => lens.command?.arguments?.[0])).toEqual([
      expect.objectContaining({ hunkIndex: 0 }),
      expect.objectContaining({ hunkIndex: 0 }),
      expect.objectContaining({ hunkIndex: 1 }),
      expect.objectContaining({ hunkIndex: 1 }),
    ]);
  });

  it('preserves hunk order for addition-only CodeLens actions', () => {
    const { provider } = createProvider();
    provider.update(state({ currentText: 'new\nother\n', hunks: [
      hunk({ modifiedStart: 0, modifiedLines: ['new'] }),
      hunk({ modifiedStart: 4, modifiedLines: ['other'] }),
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

  it('clamps negative modified starts to the first document line', () => {
    const { provider } = createProvider();
    provider.update(state({ hunks: [hunk({ modifiedStart: -4 })] }));

    const [approve] = provide(provider, 5);

    expect(approve.range).toEqual(new FakeRange(0, 3, 0, 3));
  });

  it('clamps past-end modified starts to the final document line', () => {
    const { provider } = createProvider();
    provider.update(state({ hunks: [hunk({ modifiedStart: 99 })] }));

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
