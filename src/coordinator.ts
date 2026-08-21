import { PerKeyDebouncer } from './changePolicy';
import { SnapshotStore } from './snapshotStore';
import type { ChangeHunk } from './types';

interface CoordinatorDiffEngine {
  compute(
    original: string,
    modified: string,
  ): readonly ChangeHunk[] | Promise<readonly ChangeHunk[]>;
}

export type ComparisonApplicability = () => boolean;

const ALWAYS_CURRENT: ComparisonApplicability = () => true;

export interface ComparisonView {
  render(key: string, hunks: readonly ChangeHunk[]): Promise<void>;
  clear(key: string): void;
  clearAll(): void;
}

export class ComparisonCoordinator {
  private readonly revisions = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly diffEngine: CoordinatorDiffEngine,
    private readonly snapshots: SnapshotStore,
    private readonly view: ComparisonView,
    private readonly debouncer: PerKeyDebouncer<string> = new PerKeyDebouncer<string>(),
  ) {}

  seed(key: string, text: string): void {
    if (this.disposed) {
      return;
    }

    this.debouncer.cancel(key);
    this.snapshots.setComparison(key, {
      baselineText: text,
      currentText: text,
      hunks: [],
      sourceRevision: this.nextRevision(key),
      comparisonActive: false,
      pending: false,
    });
  }

  async externalChange(
    key: string,
    text: string,
    isCurrent: ComparisonApplicability = ALWAYS_CURRENT,
  ): Promise<void> {
    if (this.disposed || !isCurrent()) {
      return;
    }

    if (this.snapshots.get(key) === undefined) {
      this.seed(key, text);
      return;
    }

    await this.compare(key, text, isCurrent);
  }

  async documentEdit(
    key: string,
    text: string,
    isCurrent: ComparisonApplicability = ALWAYS_CURRENT,
  ): Promise<void> {
    const state = this.snapshots.get(key);
    if (this.disposed || state === undefined || !state.comparisonActive || !isCurrent()) {
      return;
    }

    await this.compare(key, text, isCurrent);
  }

  invalidate(key: string): void {
    if (this.disposed) {
      return;
    }

    this.debouncer.cancel(key);
    const state = this.snapshots.get(key);
    const sourceRevision = this.nextRevision(key);
    if (state !== undefined) {
      this.snapshots.setComparison(key, { ...state, sourceRevision });
    }
  }

  save(key: string, text: string): void {
    if (this.disposed) {
      return;
    }

    this.debouncer.cancel(key);
    this.snapshots.setComparison(key, {
      baselineText: text,
      currentText: text,
      hunks: [],
      sourceRevision: this.nextRevision(key),
      comparisonActive: false,
      pending: false,
    });
    this.view.clear(key);
  }

  delete(key: string): void {
    if (this.disposed) {
      return;
    }

    this.debouncer.cancel(key);
    this.nextRevision(key);
    this.snapshots.delete(key);
    this.view.clear(key);
  }

  async show(
    key: string,
    isCurrent: (expectedText: string) => boolean = () => true,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }

    const state = this.snapshots.get(key);
    if (state === undefined || state.hunks.length === 0) {
      return;
    }

    const { currentText, hunks, sourceRevision } = state;
    if (!isCurrent(currentText)) {
      return;
    }
    await this.view.render(key, hunks);

    const current = this.snapshots.get(key);
    if (
      this.disposed
      || current?.sourceRevision !== sourceRevision
      || current.currentText !== currentText
      || current.hunks !== hunks
      || !isCurrent(currentText)
    ) {
      return;
    }

    this.snapshots.setComparison(key, { ...current, pending: false });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.debouncer.dispose();
    this.snapshots.clear();
    this.revisions.clear();
    this.view.clearAll();
  }

  private async compare(
    key: string,
    text: string,
    isCurrent: ComparisonApplicability,
  ): Promise<void> {
    const state = this.snapshots.get(key);
    if (state === undefined || !isCurrent()) {
      return;
    }

    const sourceRevision = this.nextRevision(key);
    this.snapshots.setComparison(key, {
      ...state,
      currentText: text,
      sourceRevision,
    });

    const hunks = await this.diffEngine.compute(state.baselineText, text);
    const current = this.snapshots.get(key);
    if (
      this.disposed
      || current?.sourceRevision !== sourceRevision
      || current.currentText !== text
      || !isCurrent()
    ) {
      return;
    }

    const comparisonActive = current.comparisonActive || hunks.length > 0;
    this.snapshots.setComparison(key, {
      ...current,
      hunks,
      comparisonActive,
      pending: hunks.length > 0,
    });
    if (hunks.length === 0) {
      this.view.clear(key);
      return;
    }

    await this.view.render(key, hunks);
  }

  private nextRevision(key: string): number {
    const revision = (this.revisions.get(key) ?? this.snapshots.get(key)?.sourceRevision ?? 0) + 1;
    this.revisions.set(key, revision);
    return revision;
  }
}
