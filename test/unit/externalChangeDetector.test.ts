import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecentSaveRegistry } from '../../src/changePolicy';
import {
  ExternalChangeDetector,
  type ExternalChangeCandidate,
  type ExternalChangeUri,
} from '../../src/externalChangeDetector';

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
  const onCandidate = vi.fn(async (_candidate: ExternalChangeCandidate) => undefined);
  const onError = vi.fn();
  const instance = new ExternalChangeDetector({
    readFile,
    settings: baseSettings,
    relativePath: (value) => value.path.replace('/workspace/', ''),
    onCandidate,
    onError,
    ...overrides,
  });

  return { instance, onCandidate, onError, readFile };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ExternalChangeDetector', () => {
  it('emits one present candidate when create and change notifications collapse', async () => {
    vi.useFakeTimers();
    const file = uri('new-file.ts');
    const { instance, onCandidate } = detector();

    instance.handleCreate(file);
    instance.handleChange(file);
    await vi.advanceTimersByTimeAsync(100);

    expect(onCandidate).toHaveBeenCalledWith({
      kind: 'present',
      key: file.toString(),
      uri: file,
      text: 'changed',
      bytes: encoder.encode('changed'),
    });
  });

  it('collapses repeated watcher events into one read and comparison per URI', async () => {
    vi.useFakeTimers();
    const file = uri('file.ts');
    const { instance, onCandidate, readFile } = detector();

    instance.handleChange(file);
    instance.handleCreate(file);
    await vi.advanceTimersByTimeAsync(100);

    expect(readFile).toHaveBeenCalledOnce();
    expect(onCandidate).toHaveBeenCalledOnce();
    expect(onCandidate).toHaveBeenCalledWith({
      kind: 'present',
      key: file.toString(),
      uri: file,
      text: 'changed',
      bytes: encoder.encode('changed'),
    });
  });

  it('processes distinct URI timers independently', async () => {
    vi.useFakeTimers();
    const first = uri('first.ts');
    const second = uri('second.ts');
    const readFile = vi.fn(async (value: ExternalChangeUri) => encoder.encode(value.path));
    const { instance, onCandidate } = detector({ readFile });

    instance.handleChange(first);
    instance.handleChange(second);
    await vi.advanceTimersByTimeAsync(100);

    expect(onCandidate.mock.calls).toEqual([
      [{
        kind: 'present',
        key: first.toString(),
        uri: first,
        text: first.path,
        bytes: encoder.encode(first.path),
      }],
      [{
        kind: 'present',
        key: second.toString(),
        uri: second,
        text: second.path,
        bytes: encoder.encode(second.path),
      }],
    ]);
  });

  it('suppresses exactly one watcher event marked as a recent editor save', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const file = uri('saved.ts');
    const saves = new RecentSaveRegistry();
    const { instance, onCandidate, readFile } = detector({ recentSaves: saves });

    instance.markRecentSave(file);
    instance.handleChange(file);
    await vi.advanceTimersByTimeAsync(100);
    expect(readFile).not.toHaveBeenCalled();

    instance.handleChange(file);
    await vi.advanceTimersByTimeAsync(100);
    expect(readFile).toHaveBeenCalledOnce();
    expect(onCandidate).toHaveBeenCalledOnce();
  });

  it('invalidates an already-running read when an editor save is marked', async () => {
    vi.useFakeTimers();
    const file = uri('saved-during-read.ts');
    const pendingRead = deferred<Uint8Array>();
    const readFile = vi.fn(() => pendingRead.promise);
    const { instance, onCandidate } = detector({ readFile });

    instance.handleChange(file);
    await vi.advanceTimersByTimeAsync(100);
    expect(readFile).toHaveBeenCalledOnce();

    instance.markRecentSave(file);
    pendingRead.resolve(encoder.encode('stale after save'));
    await settleAsyncWork();

    expect(onCandidate).not.toHaveBeenCalled();
  });

  it('invalidates excluded and non-file observations without reading them', async () => {
    vi.useFakeTimers();
    const excluded = uri('node_modules/package/index.js');
    const untitled = uri('scratch.ts', 'untitled');
    const { instance, onCandidate, readFile } = detector({
      settings: () => settings({ exclude: ['**/node_modules/**'] }),
    });

    instance.handleChange(excluded);
    instance.handleChange(untitled);
    await vi.advanceTimersByTimeAsync(100);

    expect(readFile).not.toHaveBeenCalled();
    expect(onCandidate.mock.calls).toEqual([
      [{ kind: 'untrackable', key: excluded.toString(), uri: excluded }],
      [{ kind: 'untrackable', key: untitled.toString(), uri: untitled }],
    ]);
  });

  it('enforces the byte limit before attempting UTF-8 decoding', async () => {
    vi.useFakeTimers();
    const invalidOversizedBytes = new Uint8Array([0xc3, 0x28]);
    const { instance, onCandidate, onError } = detector({
      readFile: vi.fn(async () => invalidOversizedBytes),
      settings: () => settings({ maxFileSizeBytes: 1 }),
    });

    instance.handleChange(uri('large.bin'));
    await vi.advanceTimersByTimeAsync(100);

    expect(onCandidate).toHaveBeenCalledWith({
      kind: 'untrackable',
      key: 'file:///workspace/large.bin',
      uri: expect.objectContaining({ path: '/workspace/large.bin' }),
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    ['NUL-containing binary content', encoder.encode('left\0right')],
    ['invalid UTF-8 content', new Uint8Array([0xc3, 0x28])],
  ])('invalidates %s', async (_description, bytes) => {
    vi.useFakeTimers();
    const file = uri('binary.dat');
    const { instance, onCandidate } = detector({ readFile: vi.fn(async () => bytes) });

    instance.handleChange(file);
    await vi.advanceTimersByTimeAsync(100);

    expect(onCandidate).toHaveBeenCalledWith({
      kind: 'untrackable',
      key: file.toString(),
      uri: file,
    });
  });

  it('emits a present candidate for an unseen created file without assigning provenance', async () => {
    vi.useFakeTimers();
    const file = uri('unseen.ts');
    const { instance, onCandidate } = detector();

    instance.handleCreate(file);
    await vi.advanceTimersByTimeAsync(100);

    expect(onCandidate).toHaveBeenCalledWith({
      kind: 'present',
      key: file.toString(),
      uri: file,
      text: 'changed',
      bytes: encoder.encode('changed'),
    });
  });

  it('debounces delete into one absent candidate without reading the file', async () => {
    vi.useFakeTimers();
    const file = uri('deleted.ts');
    const { instance, onCandidate, readFile } = detector();

    instance.handleChange(file);
    instance.handleDelete(file);
    expect(onCandidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);

    expect(readFile).not.toHaveBeenCalled();
    expect(onCandidate).toHaveBeenCalledWith({
      kind: 'absent',
      key: file.toString(),
      uri: file,
    });
  });

  it('rejects a read that resolves after a delete event', async () => {
    vi.useFakeTimers();
    const file = uri('deleted-during-read.ts');
    const pendingRead = deferred<Uint8Array>();
    const readFile = vi.fn(() => pendingRead.promise);
    const { instance, onCandidate } = detector({ readFile });

    instance.handleChange(file);
    await vi.advanceTimersByTimeAsync(100);
    expect(readFile).toHaveBeenCalledOnce();

    instance.handleDelete(file);
    pendingRead.resolve(encoder.encode('stale after delete'));
    await settleAsyncWork();
    expect(onCandidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);

    expect(onCandidate).toHaveBeenCalledTimes(1);
    expect(onCandidate).toHaveBeenCalledWith({
      kind: 'absent',
      key: file.toString(),
      uri: file,
    });
  });

  it('lets a recreate supersede a pending delete without emitting transient absence', async () => {
    vi.useFakeTimers();
    const file = uri('recreated.ts');
    const { instance, onCandidate, readFile } = detector();

    instance.handleDelete(file);
    instance.handleCreate(file);
    await vi.advanceTimersByTimeAsync(100);

    expect(readFile).toHaveBeenCalledOnce();
    expect(onCandidate).toHaveBeenCalledTimes(1);
    expect(onCandidate).toHaveBeenCalledWith({
      kind: 'present',
      key: file.toString(),
      uri: file,
      text: 'changed',
      bytes: encoder.encode('changed'),
    });
  });

  it('invalidates an already-running read when runtime state is logically removed', async () => {
    vi.useFakeTimers();
    const file = uri('removed-workspace.ts');
    const pendingRead = deferred<Uint8Array>();
    const readFile = vi.fn(() => pendingRead.promise);
    const { instance, onCandidate } = detector({ readFile });

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

    expect(onCandidate).not.toHaveBeenCalled();
  });

  it.each([
    ['a reduced byte limit', settings({ maxFileSizeBytes: 1 })],
    ['a new exclusion', settings({ exclude: ['**/during-read.ts'] })],
  ])('re-evaluates %s after an asynchronous read', async (_description, changedSettings) => {
    vi.useFakeTimers();
    const file = uri('during-read.ts');
    const pendingRead = deferred<Uint8Array>();
    let currentSettings = baseSettings();
    const { instance, onCandidate } = detector({
      readFile: vi.fn(() => pendingRead.promise),
      settings: () => currentSettings,
    });

    instance.handleChange(file);
    await vi.advanceTimersByTimeAsync(100);
    currentSettings = changedSettings;
    pendingRead.resolve(encoder.encode('changed'));
    await settleAsyncWork();

    expect(onCandidate).toHaveBeenCalledWith({
      kind: 'untrackable',
      key: file.toString(),
      uri: file,
    });
  });

  it.each(['ENOENT', 'FileNotFound'])(
    'turns a %s present-read race into an absent observation',
    async (code) => {
      vi.useFakeTimers();
      const file = uri('vanished.ts');
      const failure = Object.assign(new Error('file vanished'), { code });
      const { instance, onCandidate, onError } = detector({
        readFile: vi.fn(async () => { throw failure; }),
      });

      instance.handleChange(file);
      await vi.advanceTimersByTimeAsync(100);

      expect(onCandidate).toHaveBeenCalledWith({
        kind: 'absent',
        key: file.toString(),
        uri: file,
      });
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it('reports and invalidates other read failures without throwing from the timer callback', async () => {
    vi.useFakeTimers();
    const failure = new Error('read failed');
    const file = uri('unreadable.ts');
    const { instance, onCandidate, onError } = detector({
      readFile: vi.fn(async () => { throw failure; }),
    });

    instance.handleChange(file);
    await vi.advanceTimersByTimeAsync(100);

    expect(onCandidate).toHaveBeenCalledWith({
      kind: 'untrackable',
      key: file.toString(),
      uri: file,
    });
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('rereads a save even when its matching watcher event is suppressed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const file = uri('saved.ts');
    const saves = new RecentSaveRegistry();
    const { instance, onCandidate, readFile } = detector({ recentSaves: saves });

    instance.markRecentSave(file);
    instance.handleSave(file);
    await vi.advanceTimersByTimeAsync(100);

    expect(readFile).toHaveBeenCalledOnce();
    expect(onCandidate).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'present',
      key: file.toString(),
      bytes: encoder.encode('changed'),
    }));
  });

  it('keeps the direct save read when its matching watcher event arrives afterward', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const file = uri('saved-first.ts');
    const saves = new RecentSaveRegistry();
    const { instance, onCandidate, readFile } = detector({ recentSaves: saves });

    instance.markRecentSave(file);
    instance.handleSave(file);
    instance.handleChange(file);
    await vi.advanceTimersByTimeAsync(100);

    expect(readFile).toHaveBeenCalledOnce();
    expect(onCandidate).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'present',
      key: file.toString(),
      bytes: encoder.encode('changed'),
    }));
  });
});
