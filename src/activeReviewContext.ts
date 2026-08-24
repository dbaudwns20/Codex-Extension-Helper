import type { FileComparisonState } from './types';

export const ACTIVE_FILE_HAS_CHANGES_CONTEXT = 'codexExtensionHelper.activeFileHasChanges';

export type SetReviewContext = (
  key: typeof ACTIVE_FILE_HAS_CHANGES_CONTEXT,
  value: boolean,
) => void | PromiseLike<unknown>;

export class ActiveReviewContext {
  private requestedValue: boolean | undefined;
  private disposed = false;

  constructor(private readonly setContext: SetReviewContext) {}

  async update(
    activeKey: string | undefined,
    state: FileComparisonState | undefined,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }

    await this.write(
      activeKey !== undefined
      && state?.pending === true
      && state.hunks.length > 0,
    );
  }

  async clear(): Promise<void> {
    if (!this.disposed) {
      await this.write(false);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    void this.write(false);
  }

  private async write(value: boolean): Promise<void> {
    if (this.requestedValue === value) {
      return;
    }

    this.requestedValue = value;
    try {
      await this.setContext(ACTIVE_FILE_HAS_CHANGES_CONTEXT, value);
    } catch {
      if (this.requestedValue === value) {
        this.requestedValue = undefined;
      }
    }
  }
}
