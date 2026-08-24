import { describe, expect, it, vi } from 'vitest';
import { ActiveReviewContext } from '../../src/activeReviewContext';
import type { ChangeHunk, FileComparisonState } from '../../src/types';

const ACTIVE_FILE_CONTEXT = 'codexExtensionHelper.activeFileHasChanges';

function hunk(): ChangeHunk {
  return {
    kind: 'addition',
    originalStart: 0,
    originalEnd: 0,
    modifiedStart: 0,
    modifiedEnd: 1,
    originalLines: [],
    modifiedLines: ['new'],
  };
}

function state(overrides: Partial<FileComparisonState> = {}): FileComparisonState {
  return {
    baselineText: 'old\n',
    currentText: 'new\n',
    hunks: [hunk()],
    sourceRevision: 2,
    comparisonActive: true,
    pending: true,
    createdFile: false,
    ...overrides,
  };
}

describe('ActiveReviewContext', () => {
  it('tracks pending hunks as the active editor changes', async () => {
    const setContext = vi.fn().mockResolvedValue(undefined);
    const context = new ActiveReviewContext(setContext);

    await context.update('file:///first.ts', state());
    await context.update('file:///second.ts', undefined);

    expect(setContext.mock.calls).toEqual([
      [ACTIVE_FILE_CONTEXT, true],
      [ACTIVE_FILE_CONTEXT, false],
    ]);
  });

  it('does not issue another command when an inactive-file change leaves the active value unchanged', async () => {
    const setContext = vi.fn().mockResolvedValue(undefined);
    const context = new ActiveReviewContext(setContext);
    const activeState = state();

    await context.update('file:///active.ts', activeState);
    await context.update('file:///active.ts', activeState);

    expect(setContext).toHaveBeenCalledOnce();
    expect(setContext).toHaveBeenCalledWith(ACTIVE_FILE_CONTEXT, true);
  });

  it('clears when the active comparison becomes non-pending or has no hunks', async () => {
    const setContext = vi.fn().mockResolvedValue(undefined);
    const context = new ActiveReviewContext(setContext);

    await context.update('file:///active.ts', state());
    await context.update('file:///active.ts', state({ pending: false }));
    await context.update('file:///active.ts', state({ hunks: [] }));

    expect(setContext.mock.calls).toEqual([
      [ACTIVE_FILE_CONTEXT, true],
      [ACTIVE_FILE_CONTEXT, false],
    ]);
  });

  it('clears after the active file is deleted', async () => {
    const setContext = vi.fn().mockResolvedValue(undefined);
    const context = new ActiveReviewContext(setContext);

    await context.update('file:///active.ts', state());
    await context.update(undefined, undefined);

    expect(setContext).toHaveBeenLastCalledWith(ACTIVE_FILE_CONTEXT, false);
  });

  it('clears on extension disable without redundant false commands', async () => {
    const setContext = vi.fn().mockResolvedValue(undefined);
    const context = new ActiveReviewContext(setContext);

    await context.update('file:///active.ts', state());
    await context.clear();
    await context.clear();

    expect(setContext.mock.calls).toEqual([
      [ACTIVE_FILE_CONTEXT, true],
      [ACTIVE_FILE_CONTEXT, false],
    ]);
  });

  it('clears once on dispose and ignores later updates', async () => {
    const setContext = vi.fn().mockResolvedValue(undefined);
    const context = new ActiveReviewContext(setContext);
    await context.update('file:///active.ts', state());

    context.dispose();
    await context.update('file:///active.ts', state());
    context.dispose();

    expect(setContext.mock.calls).toEqual([
      [ACTIVE_FILE_CONTEXT, true],
      [ACTIVE_FILE_CONTEXT, false],
    ]);
  });

  it('contains setContext failures so event callbacks cannot reject unhandled', async () => {
    const context = new ActiveReviewContext(vi.fn().mockRejectedValue(new Error('setContext failed')));

    await expect(context.update('file:///active.ts', state())).resolves.toBeUndefined();
    await expect(context.clear()).resolves.toBeUndefined();
    expect(() => context.dispose()).not.toThrow();
  });
});
