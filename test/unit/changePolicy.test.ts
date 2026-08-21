import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerKeyDebouncer, RecentSaveRegistry } from '../../src/changePolicy';

describe('RecentSaveRegistry', () => {
  it('consumes one watcher event within the save suppression window', () => {
    const saves = new RecentSaveRegistry();
    const uri = 'file:///workspace/file.ts';
    saves.mark(uri, 1_000);

    expect(saves.consume(uri, 2_999)).toBe(true);
    expect(saves.consume(uri, 3_000)).toBe(false);
  });

  it('does not suppress an event after the save window expires', () => {
    const saves = new RecentSaveRegistry();
    const uri = 'file:///workspace/file.ts';
    saves.mark(uri, 1_000);

    expect(saves.consume(uri, 3_001)).toBe(false);
  });
});

describe('PerKeyDebouncer', () => {
  afterEach(() => vi.useRealTimers());

  it('collapses repeated events for one URI', () => {
    vi.useFakeTimers();
    const debouncer = new PerKeyDebouncer<string>();
    const callback = vi.fn();

    debouncer.schedule('file:///workspace/file.ts', 100, callback);
    debouncer.schedule('file:///workspace/file.ts', 100, callback);
    vi.advanceTimersByTime(100);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('keeps timers independent for distinct URIs', () => {
    vi.useFakeTimers();
    const debouncer = new PerKeyDebouncer<string>();
    const first = vi.fn();
    const second = vi.fn();

    debouncer.schedule('file:///workspace/first.ts', 100, first);
    debouncer.schedule('file:///workspace/second.ts', 200, second);
    vi.advanceTimersByTime(100);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('cancels one scheduled callback without affecting other keys', () => {
    vi.useFakeTimers();
    const debouncer = new PerKeyDebouncer<string>();
    const cancelled = vi.fn();
    const retained = vi.fn();

    debouncer.schedule('file:///workspace/cancelled.ts', 100, cancelled);
    debouncer.schedule('file:///workspace/retained.ts', 100, retained);
    debouncer.cancel('file:///workspace/cancelled.ts');
    vi.advanceTimersByTime(100);

    expect(cancelled).not.toHaveBeenCalled();
    expect(retained).toHaveBeenCalledTimes(1);
  });

  it('cancels every scheduled callback when disposed', () => {
    vi.useFakeTimers();
    const debouncer = new PerKeyDebouncer<string>();
    const callback = vi.fn();
    debouncer.schedule('file:///workspace/file.ts', 100, callback);

    debouncer.dispose();
    vi.advanceTimersByTime(100);

    expect(callback).not.toHaveBeenCalled();
  });
});
