import type { FileComparisonState } from './types';

export const ACTIVE_FILE_HAS_CHANGES_CONTEXT = 'codexExtensionHelper.activeFileHasChanges';

export type SetReviewContext = (
  key: typeof ACTIVE_FILE_HAS_CHANGES_CONTEXT,
  value: boolean,
) => void | PromiseLike<unknown>;

export class ActiveReviewContext {
  private requestedValue: boolean | undefined;
  private requestRevision = 0;
  private appliedValue: boolean | undefined;
  private flushPromise: Promise<void> | undefined;
  private resolveFlush: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly setContext: SetReviewContext) {}

  update(
    activeKey: string | undefined,
    state: FileComparisonState | undefined,
  ): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    return this.enqueue(
      activeKey !== undefined
      && state?.pending === true
      && state.hunks.length > 0,
    );
  }

  clear(): Promise<void> {
    return this.disposed ? Promise.resolve() : this.enqueue(false);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    void this.enqueue(false);
  }

  private enqueue(value: boolean): Promise<void> {
    if (this.requestedValue !== value) {
      this.requestedValue = value;
      this.requestRevision += 1;
    }
    if (this.flushPromise !== undefined) {
      return this.flushPromise;
    }
    if (this.appliedValue === value) {
      return Promise.resolve();
    }

    const flush = new Promise<void>((resolve) => {
      this.resolveFlush = resolve;
    });
    this.flushPromise = flush;
    void this.drain();
    return flush;
  }

  private async drain(): Promise<void> {
    while (this.requestedValue !== undefined && this.appliedValue !== this.requestedValue) {
      const value = this.requestedValue;
      const revision = this.requestRevision;
      try {
        await this.setContext(ACTIVE_FILE_HAS_CHANGES_CONTEXT, value);
        this.appliedValue = value;
      } catch {
        if (this.requestRevision === revision) {
          break;
        }
      }
    }

    const resolve = this.resolveFlush;
    this.flushPromise = undefined;
    this.resolveFlush = undefined;
    resolve?.();
  }
}
