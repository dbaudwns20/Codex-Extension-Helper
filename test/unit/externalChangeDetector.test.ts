import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecentSaveRegistry } from '../../src/changePolicy';
import { ComparisonCoordinator, type ComparisonView } from '../../src/coordinator';
import {
  ExternalChangeDetector,
  type ExternalChangeUri,
} from '../../src/externalChangeDetector';
import { SnapshotStore } from '../../src/snapshotStore';

const encoder = new TextEncoder();

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
