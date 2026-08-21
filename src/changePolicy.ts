export class RecentSaveRegistry {
  private readonly savedAt = new Map<string, number>();

  constructor(private readonly windowMs = 2_000) {}

  mark(uri: string, now: number): void {
    this.savedAt.set(uri, now);
  }

  consume(uri: string, now: number): boolean {
    const savedAt = this.savedAt.get(uri);
    if (savedAt === undefined) {
      return false;
    }

    this.savedAt.delete(uri);
    return now >= savedAt && now - savedAt < this.windowMs;
  }
}

export class PerKeyDebouncer<K> {
  private readonly timers = new Map<K, ReturnType<typeof setTimeout>>();

  schedule(key: K, delayMs: number, callback: () => void): void {
    this.cancel(key);

    const timer = setTimeout(() => {
      if (this.timers.get(key) !== timer) {
        return;
      }

      this.timers.delete(key);
      callback();
    }, delayMs);
    this.timers.set(key, timer);
  }

  cancel(key: K): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
