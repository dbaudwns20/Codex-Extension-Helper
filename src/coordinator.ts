import { PerKeyDebouncer } from './changePolicy';
import { SnapshotStore } from './snapshotStore';
import type { ChangeHunk } from './types';

interface CoordinatorDiffEngine {
  compute(
    original: string,
    modified: string,
  ): readonly ChangeHunk[] | Promise<readonly ChangeHunk[]>;
}

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
      pending: false,
    });
  }

  async externalChange(key: string, text: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (this.snapshots.get(key) === undefined) {
      this.seed(key, text);
      return;
    }

    await this.compare(key, text);
  }

  async documentEdit(key: string, text: string): Promise<void> {
    if (this.disposed || this.snapshots.get(key) === undefined) {
      return;
    }

    await this.compare(key, text);
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

  async show(key: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    const state = this.snapshots.get(key);
    if (state === undefined || state.hunks.length === 0) {
      return;
    }

    const { currentText, hunks, sourceRevision } = state;
    await this.view.render(key, hunks);

    const current = this.snapshots.get(key);
    if (
      this.disposed
      || current?.sourceRevision !== sourceRevision
      || current.currentText !== currentText
      || current.hunks !== hunks
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

  private async compare(key: string, text: string): Promise<void> {
    const state = this.snapshots.get(key);
    if (state === undefined) {
      return;
    }

    const sourceRevision = this.nextRevision(key);
    this.snapshots.setComparison(key, {
      ...state,
      currentText: text,
      sourceRevision,
      pending: true,
    });

    const hunks = await this.diffEngine.compute(state.baselineText, text);
    const current = this.snapshots.get(key);
    if (
      this.disposed
      || current?.sourceRevision !== sourceRevision
      || current.currentText !== text
    ) {
      return;
    }

    this.snapshots.setComparison(key, { ...current, hunks, pending: true });
    await this.view.render(key, hunks);
  }

  private nextRevision(key: string): number {
    const revision = (this.revisions.get(key) ?? this.snapshots.get(key)?.sourceRevision ?? 0) + 1;
    this.revisions.set(key, revision);
    return revision;
  }
}
