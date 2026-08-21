import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecentSaveRegistry } from '../../src/changePolicy';
import { ComparisonCoordinator, type ComparisonView } from '../../src/coordinator';
import {
  ExternalChangeDetector,
  type ExternalChangeUri,
} from '../../src/externalChangeDetector';
import { SnapshotStore } from '../../src/snapshotStore';

const encoder = new TextEncoder();

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function settleAsyncWork(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

function uri(relativePath: string, scheme = 'file'): ExternalChangeUri {
  return {
    scheme,
    path: `/workspace/${relativePath}`,
    toString: () => `${scheme}:///workspace/${relativePath}`,
  };
}

function settings(overrides: Partial<ReturnType<typeof baseSettings>> = {}) {
  return { ...baseSettings(), ...overrides };
}

function baseSettings() {
  return {
    enabled: true,
    debounceMs: 100,
    maxFileSizeBytes: 1024,
    exclude: [] as readonly string[],
  };
}

function detector(overrides: Partial<ConstructorParameters<typeof ExternalChangeDetector>[0]> = {}) {
  const readFile = vi.fn(async () => encoder.encode('changed'));
  const onComparison = vi.fn(async () => undefined);
  const onDelete = vi.fn();
  const onError = vi.fn();
  const instance = new ExternalChangeDetector({
    readFile,
    settings: baseSettings,
    relativePath: (value) => value.path.replace('/workspace/', ''),
    onComparison,
    onDelete,
    onError,
    ...overrides,
  });

  return { instance, onComparison, onDelete, onError, readFile };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ExternalChangeDetector', () => {
  it('collapses repeated watcher events into one read and comparison per URI', async () => {
    vi.useFakeTimers();
    const file = uri('file.ts');
    const { instance, onComparison, readFile } = detector();

    instance.handleChange(file);
    instance.handleCreate(file);
    await vi.advanceTimersByTimeAsync(100);

    expect(readFile).toHaveBeenCalledOnce();
    expect(onComparison).toHaveBeenCalledOnce();
    expect(onComparison).toHaveBeenCalledWith(file.toString(), 'changed');
  });

  it('processes distinct URI timers independently', async () => {
    vi.useFakeTimers();
    const first = uri('first.ts');
    const second = uri('second.ts');
    const readFile = vi.fn(async (value: ExternalChangeUri) => encoder.encode(value.path));
    const { instance, onComparison } = detector({ readFile });

    instance.handleChange(first);
    instance.handleChange(second);
    await vi.advanceTimersByTimeAsync(100);

    expect(onComparison.mock.calls).toEqual([
      [first.toString(), first.path],
      [second.toString(), second.path],
    ]);
  });

  it('suppresses exactly one watcher event marked as a recent editor save', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const file = uri('saved.ts');
    const saves = new RecentSaveRegistry();
    const { instance, onComparison, readFile } = detector({ recentSaves: saves });

    instance.markRecentSave(file);
    instance.handleChange(file);
    await vi.advanceTimersByTimeAsync(100);
    expect(readFile).not.toHaveBeenCalled();

    instance.handleChange(file);
    await vi.advanceTimersByTimeAsync(100);
    expect(readFile).toHaveBeenCalledOnce();
    expect(onComparison).toHaveBeenCalledOnce();
  });

  it('invalidates an already-running read when an editor save is marked', async () => {
    vi.useFakeTimers();
    const file = uri('saved-during-read.ts');
    const pendingRead = deferred<Uint8Array>();
    const readFile = vi.fn(() => pendingRead.promise);
    const { instance, onComparison } = detector({ readFile });

    instance.handleChange(file);
    await vi.advanceTimersByTimeAsync(100);
    expect(readFile).toHaveBeenCalledOnce();

    instance.markRecentSave(file);
    pendingRead.resolve(encoder.encode('stale after save'));
    await settleAsyncWork();

    expect(onComparison).not.toHaveBeenCalled();
  });

  it('skips excluded and non-file URIs without reading them', async () => {
    vi.useFakeTimers();
    const excluded = uri('node_modules/package/index.js');
    const untitled = uri('scratch.ts', 'untitled');
    const { instance, onComparison, readFile } = detector({
      settings: () => settings({ exclude: ['**/node_modules/**'] }),
    });

    instance.handleChange(excluded);
    instance.handleChange(untitled);
    await vi.advanceTimersByTimeAsync(100);

    expect(readFile).not.toHaveBeenCalled();
    expect(onComparison).not.toHaveBeenCalled();
  });

  it('enforces the byte limit before attempting UTF-8 decoding', async () => {
    vi.useFakeTimers();
    const invalidOversizedBytes = new Uint8Array([0xc3, 0x28]);
    const { instance, onComparison, onError } = detector({
      readFile: vi.fn(async () => invalidOversizedBytes),
      settings: () => settings({ maxFileSizeBytes: 1 }),
    });

    instance.handleChange(uri('large.bin'));
    await vi.advanceTimersByTimeAsync(100);

    expect(onComparison).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    ['NUL-containing binary content', encoder.encode('left\0right')],
    ['invalid UTF-8 content', new Uint8Array([0xc3, 0x28])],
  ])('skips %s', async (_description, bytes) => {
    vi.useFakeTimers();
    const { instance, onComparison } = detector({ readFile: vi.fn(async () => bytes) });

    instance.handleChange(uri('binary.dat'));
    await vi.advanceTimersByTimeAsync(100);

    expect(onComparison).not.toHaveBeenCalled();
  });

  it('seeds unseen content through the coordinator without rendering a comparison', async () => {
    vi.useFakeTimers();
    const file = uri('unseen.ts');
    const store = new SnapshotStore();
    const view: ComparisonView = {
      render: vi.fn(async () => undefined),
      clear: vi.fn(),
      clearAll: vi.fn(),
    };
    const diffEngine = { compute: vi.fn(() => []) };
    const coordinator = new ComparisonCoordinator(diffEngine, store, view);
    const { instance } = detector({
      onComparison: (key, text) => coordinator.externalChange(key, text),
    });

    instance.handleCreate(file);
    await vi.advanceTimersByTimeAsync(100);

    expect(store.get(file.toString())).toMatchObject({
      baselineText: 'changed',
      currentText: 'changed',
      hunks: [],
      pending: false,
    });
    expect(diffEngine.compute).not.toHaveBeenCalled();
    expect(view.render).not.toHaveBeenCalled();
  });

  it('cancels a pending read and clears coordinator state on delete', async () => {
    vi.useFakeTimers();
    const file = uri('deleted.ts');
    const store = new SnapshotStore();
    const view: ComparisonView = {
      render: vi.fn(async () => undefined),
      clear: vi.fn(),
      clearAll: vi.fn(),
    };
    const coordinator = new ComparisonCoordinator({ compute: () => [] }, store, view);
    coordinator.seed(file.toString(), 'baseline');
    const { instance, readFile } = detector({
      onDelete: (key) => coordinator.delete(key),
    });

    instance.handleChange(file);
    instance.handleDelete(file);
    await vi.advanceTimersByTimeAsync(100);

    expect(readFile).not.toHaveBeenCalled();
    expect(store.get(file.toString())).toBeUndefined();
    expect(view.clear).toHaveBeenCalledWith(file.toString());
  });

  it('rejects a read that resolves after a delete event', async () => {
    vi.useFakeTimers();
    const file = uri('deleted-during-read.ts');
    const pendingRead = deferred<Uint8Array>();
    const readFile = vi.fn(() => pendingRead.promise);
    const { instance, onComparison, onDelete } = detector({ readFile });

    instance.handleChange(file);
    await vi.advanceTimersByTimeAsync(100);
    expect(readFile).toHaveBeenCalledOnce();

    instance.handleDelete(file);
    pendingRead.resolve(encoder.encode('stale after delete'));
    await settleAsyncWork();

    expect(onDelete).toHaveBeenCalledWith(file.toString());
    expect(onComparison).not.toHaveBeenCalled();
  });

  it('invalidates an already-running read when runtime state is logically removed', async () => {
    vi.useFakeTimers();
    const file = uri('removed-workspace.ts');
    const pendingRead = deferred<Uint8Array>();
    const readFile = vi.fn(() => pendingRead.promise);
    const { instance, onComparison } = detector({ readFile });

    instance.handleChange(file);
    await vi.advanceTimersByTimeAsync(100);
    expect(readFile).toHaveBeenCalledOnce();

    const invalidate = (instance as ExternalChangeDetector & {
      invalidate?: (key: string) => void;
    }).invalidate;
    expect(typeof invalidate).toBe('function');
    if (invalidate === undefined) {
      return;
    }
    invalidate.call(instance, file.toString());
    pendingRead.resolve(encoder.encode('stale content'));
    await settleAsyncWork();

    expect(onComparison).not.toHaveBeenCalled();
  });

  it.each([
    ['a reduced byte limit', settings({ maxFileSizeBytes: 1 })],
    ['a new exclusion', settings({ exclude: ['**/during-read.ts'] })],
  ])('re-evaluates %s after an asynchronous read', async (_description, changedSettings) => {
    vi.useFakeTimers();
    const file = uri('during-read.ts');
    const pendingRead = deferred<Uint8Array>();
    let currentSettings = baseSettings();
    const { instance, onComparison } = detector({
      readFile: vi.fn(() => pendingRead.promise),
      settings: () => currentSettings,
    });

    instance.handleChange(file);
    await vi.advanceTimersByTimeAsync(100);
    currentSettings = changedSettings;
    pendingRead.resolve(encoder.encode('changed'));
    await settleAsyncWork();

    expect(onComparison).not.toHaveBeenCalled();
  });

  it('reports read failures without throwing from the timer callback', async () => {
    vi.useFakeTimers();
    const failure = new Error('read failed');
    const { instance, onComparison, onError } = detector({
      readFile: vi.fn(async () => { throw failure; }),
    });

    instance.handleChange(uri('unreadable.ts'));
    await vi.advanceTimersByTimeAsync(100);

    expect(onComparison).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
