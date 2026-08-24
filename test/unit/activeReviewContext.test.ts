import { describe, expect, it, vi } from 'vitest';
import { ActiveReviewContext } from '../../src/activeReviewContext';
import type { ChangeHunk, FileComparisonState } from '../../src/types';

const ACTIVE_FILE_CONTEXT = 'codexExtensionHelper.activeFileHasChanges';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

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

  it('serializes false behind an in-flight true and makes duplicate callers await one flush', async () => {
    const trueWrite = deferred<void>();
    const falseWrite = deferred<void>();
    const applied: boolean[] = [];
    const setContext = vi.fn((_key: string, value: boolean) => {
      const write = value ? trueWrite : falseWrite;
      return write.promise.then(() => {
        applied.push(value);
      });
    });
    const context = new ActiveReviewContext(setContext);

    const first = context.update('file:///active.ts', state());
    const duplicate = context.update('file:///active.ts', state());
    const cleared = context.clear();

    expect(duplicate).toBe(first);
    expect(cleared).toBe(first);
    expect(setContext.mock.calls).toEqual([[ACTIVE_FILE_CONTEXT, true]]);

    trueWrite.resolve();
    await trueWrite.promise;
    await Promise.resolve();
    expect(setContext.mock.calls).toEqual([
      [ACTIVE_FILE_CONTEXT, true],
      [ACTIVE_FILE_CONTEXT, false],
    ]);
    expect(applied).toEqual([true]);

    falseWrite.resolve();
    await Promise.all([first, duplicate, cleared]);
    expect(applied).toEqual([true, false]);
  });

  it('queues false after an in-flight true on dispose and prevents later true requests', async () => {
    const trueWrite = deferred<void>();
    const falseWrite = deferred<void>();
    const applied: boolean[] = [];
    const setContext = vi.fn((_key: string, value: boolean) => {
      const write = value ? trueWrite : falseWrite;
      return write.promise.then(() => {
        applied.push(value);
      });
    });
    const context = new ActiveReviewContext(setContext);

    const active = context.update('file:///active.ts', state());
    context.dispose();
    await context.update('file:///active.ts', state());
    expect(setContext.mock.calls).toEqual([[ACTIVE_FILE_CONTEXT, true]]);

    trueWrite.resolve();
    await trueWrite.promise;
    await Promise.resolve();
    expect(setContext.mock.calls).toEqual([
      [ACTIVE_FILE_CONTEXT, true],
      [ACTIVE_FILE_CONTEXT, false],
    ]);

    falseWrite.resolve();
    await active;
    expect(applied).toEqual([true, false]);
    expect(setContext).toHaveBeenCalledTimes(2);
  });

  it('contains an in-flight failure and still applies the latest queued value', async () => {
    const failedTrue = deferred<void>();
    const falseWrite = deferred<void>();
    const laterTrue = deferred<void>();
    const applied: boolean[] = [];
    const writes = [failedTrue, falseWrite, laterTrue];
    const setContext = vi.fn((_key: string, value: boolean) => {
      const write = writes.shift();
      if (write === undefined) {
        throw new Error('No queued setContext result');
      }
      return write.promise.then(() => {
        applied.push(value);
      });
    });
    const context = new ActiveReviewContext(setContext);

    const active = context.update('file:///active.ts', state());
    const cleared = context.clear();
    expect(setContext.mock.calls).toEqual([[ACTIVE_FILE_CONTEXT, true]]);
    failedTrue.reject(new Error('setContext failed'));
    await expect(failedTrue.promise).rejects.toThrow('setContext failed');
    await Promise.resolve();
    expect(setContext).toHaveBeenLastCalledWith(ACTIVE_FILE_CONTEXT, false);

    falseWrite.resolve();
    await expect(Promise.all([active, cleared])).resolves.toEqual([undefined, undefined]);
    expect(applied).toEqual([false]);

    const reactivated = context.update('file:///active.ts', state());
    expect(setContext).toHaveBeenLastCalledWith(ACTIVE_FILE_CONTEXT, true);
    laterTrue.resolve();
    await reactivated;
    expect(applied).toEqual([false, true]);
  });

  it('retries a failed value when a newer request returns to that value', async () => {
    const failedTrue = deferred<void>();
    const retriedTrue = deferred<void>();
    const writes = [failedTrue, retriedTrue];
    const setContext = vi.fn(() => {
      const write = writes.shift();
      if (write === undefined) {
        throw new Error('No queued setContext result');
      }
      return write.promise;
    });
    const context = new ActiveReviewContext(setContext);

    const first = context.update('file:///active.ts', state());
    const cleared = context.clear();
    const latest = context.update('file:///active.ts', state());
    expect(first).toBe(cleared);
    expect(first).toBe(latest);

    failedTrue.reject(new Error('setContext failed'));
    await expect(failedTrue.promise).rejects.toThrow('setContext failed');
    await Promise.resolve();
    expect(setContext).toHaveBeenCalledTimes(2);
    expect(setContext).toHaveBeenLastCalledWith(ACTIVE_FILE_CONTEXT, true);

    retriedTrue.resolve();
    await expect(first).resolves.toBeUndefined();
  });
});
