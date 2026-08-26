import { PerKeyDebouncer } from './changePolicy';
import { applyApprovedHunk } from './reviewText';
import { SnapshotStore } from './snapshotStore';
import type {
  ChangeHunk,
  ExactCodexProvenance,
  FileComparisonState,
  FileLifecycle,
  HunkReference,
} from './types';

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

    this.acceptExternalStateNow(key, text);
  }

  async externalChange(
    key: string,
    text: string,
    isCurrent: ComparisonApplicability = ALWAYS_CURRENT,
  ): Promise<void> {
    if (this.disposed || !isCurrent()) {
      return;
    }

    await this.acceptExternalState(key, text);
  }

  async externalCreate(
    key: string,
    text: string,
    isCurrent: ComparisonApplicability = ALWAYS_CURRENT,
  ): Promise<void> {
    if (this.disposed || !isCurrent()) {
      return;
    }

    await this.acceptExternalState(key, text);
  }

  async provenChange(
    key: string,
    beforeText: string,
    afterText: string,
    lifecycle: FileLifecycle,
    provenance: ExactCodexProvenance,
  ): Promise<void> {
    if (this.disposed || !this.provenTransitionMatchesAcceptedState(
      key,
      beforeText,
      afterText,
      lifecycle,
    )) {
      return;
    }

    this.debouncer.cancel(key);
    const sourceRevision = this.nextRevision(key);
    const exactProvenance = this.immutableProvenance(provenance);
    const baselineText = lifecycle === 'created' ? '' : beforeText;
    const currentText = lifecycle === 'deleted' ? '' : afterText;
    this.snapshots.setComparison(key, {
      baselineText,
      currentText,
      hunks: [],
      sourceRevision,
      comparisonActive: false,
      pending: false,
      lifecycle,
      provenance: exactProvenance,
    });

    const hunks = await this.diffEngine.compute(baselineText, currentText);
    const current = this.snapshots.get(key);
    if (
      this.disposed
      || current?.sourceRevision !== sourceRevision
      || current.baselineText !== baselineText
      || current.currentText !== currentText
      || current.lifecycle !== lifecycle
      || current.provenance !== exactProvenance
    ) {
      return;
    }

    if (hunks.length === 0 && lifecycle === 'existing') {
      this.snapshots.setAcceptedText(key, currentText);
      this.snapshots.setComparison(key, this.inactiveExistingState(currentText, sourceRevision));
      this.view.clear(key);
      return;
    }

    this.snapshots.setComparison(key, {
      ...current,
      hunks,
      comparisonActive: true,
      pending: true,
    });
    if (hunks.length === 0) {
      return;
    }
    await this.view.render(key, hunks);
    const rendered = this.snapshots.get(key);
    if (
      this.disposed
      || rendered?.sourceRevision !== sourceRevision
      || rendered.baselineText !== baselineText
      || rendered.currentText !== currentText
      || rendered.hunks !== hunks
      || rendered.lifecycle !== lifecycle
      || rendered.provenance !== exactProvenance
    ) {
      await this.synchronizeView(key);
    }
  }

  async acceptExternalState(key: string, currentText: string | undefined): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.acceptExternalStateNow(key, currentText);
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

    this.acceptExternalStateNow(key, text);
  }

  state(key: string): FileComparisonState | undefined {
    return this.snapshots.get(key);
  }

  resolveHunk(reference: HunkReference):
    | { status: 'ok'; state: FileComparisonState; hunk: ChangeHunk }
    | { status: 'missing' | 'stale' } {
    const state = this.snapshots.get(reference.key);
    if (state === undefined) {
      return { status: 'missing' };
    }

    if (
      state.sourceRevision !== reference.sourceRevision
      || state.currentText !== reference.expectedText
      || reference.hunkIndex < 0
      || reference.hunkIndex >= state.hunks.length
    ) {
      return { status: 'stale' };
    }

    return { status: 'ok', state, hunk: state.hunks[reference.hunkIndex] };
  }

  async approveHunk(reference: HunkReference): Promise<'approved' | 'missing' | 'stale'> {
    const resolved = this.resolveHunk(reference);
    if (resolved.status !== 'ok') {
      return resolved.status;
    }

    const baselineText = applyApprovedHunk(resolved.state.baselineText, resolved.hunk);
    const sourceRevision = this.nextRevision(reference.key);
    const currentText = resolved.state.currentText;
    this.snapshots.setAcceptedText(reference.key, baselineText);
    this.snapshots.setComparison(reference.key, {
      ...resolved.state,
      baselineText,
      hunks: [],
      sourceRevision,
      pending: true,
    });

    const hunks = await this.diffEngine.compute(baselineText, currentText);
    const current = this.snapshots.get(reference.key);
    if (
      this.disposed
      || current?.sourceRevision !== sourceRevision
      || current.baselineText !== baselineText
      || current.currentText !== currentText
    ) {
      return 'stale';
    }

    if (hunks.length === 0) {
      if (current.lifecycle === 'deleted') {
        this.snapshots.delete(reference.key);
      } else {
        this.snapshots.setAcceptedText(reference.key, currentText);
        this.snapshots.setComparison(
          reference.key,
          this.inactiveExistingState(currentText, sourceRevision),
        );
      }
      this.view.clear(reference.key);
      return 'approved';
    }

    this.snapshots.setComparison(reference.key, {
      ...current,
      hunks,
      comparisonActive: true,
      pending: true,
    });
    await this.view.render(reference.key, hunks);
    const rendered = this.snapshots.get(reference.key);
    if (
      this.disposed
      || rendered?.sourceRevision !== sourceRevision
      || rendered.baselineText !== baselineText
      || rendered.currentText !== currentText
      || rendered.hunks !== hunks
    ) {
      await this.synchronizeView(reference.key);
      return 'stale';
    }
    return 'approved';
  }

  approveAll(key: string, expectedText: string): 'approved' | 'missing' | 'stale' {
    const state = this.snapshots.get(key);
    if (state === undefined) {
      return 'missing';
    }
    if (state.currentText !== expectedText) {
      return 'stale';
    }

    const sourceRevision = this.nextRevision(key);
    if (state.lifecycle === 'deleted') {
      this.snapshots.delete(key);
    } else {
      this.snapshots.setAcceptedText(key, expectedText);
      this.snapshots.setComparison(key, this.inactiveExistingState(expectedText, sourceRevision));
    }
    this.view.clear(key);
    return 'approved';
  }

  delete(key: string): void {
    if (this.disposed) {
      return;
    }

    this.acceptExternalStateNow(key, undefined);
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
      await this.synchronizeView(key);
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
    if (
      state === undefined
      || !isCurrent()
    ) {
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
    if (hunks.length === 0) {
      this.snapshots.setAcceptedText(key, text);
      this.snapshots.setComparison(key, this.inactiveExistingState(text, sourceRevision));
      this.view.clear(key);
      return;
    }

    this.snapshots.setComparison(key, {
      ...current,
      hunks,
      comparisonActive,
      pending: true,
    });

    await this.view.render(key, hunks);
    const rendered = this.snapshots.get(key);
    if (
      this.disposed
      || rendered?.sourceRevision !== sourceRevision
      || rendered.baselineText !== state.baselineText
      || rendered.currentText !== text
      || rendered.hunks !== hunks
      || !isCurrent()
    ) {
      await this.synchronizeView(key);
    }
  }

  private acceptExternalStateNow(key: string, currentText: string | undefined): void {
    this.debouncer.cancel(key);
    const sourceRevision = this.nextRevision(key);
    if (currentText === undefined) {
      this.snapshots.delete(key);
    } else {
      this.snapshots.setAcceptedText(key, currentText);
      this.snapshots.setComparison(key, this.inactiveExistingState(currentText, sourceRevision));
    }
    this.view.clear(key);
  }

  private provenTransitionMatchesAcceptedState(
    key: string,
    beforeText: string,
    afterText: string,
    lifecycle: FileLifecycle,
  ): boolean {
    const acceptedText = this.snapshots.acceptedText(key);
    if (lifecycle === 'created') {
      return acceptedText === undefined && beforeText === '';
    }
    if (acceptedText === undefined || acceptedText !== beforeText) {
      return false;
    }
    return lifecycle !== 'deleted' || afterText === '';
  }

  private inactiveExistingState(text: string, sourceRevision: number): FileComparisonState {
    return {
      baselineText: text,
      currentText: text,
      hunks: [],
      sourceRevision,
      comparisonActive: false,
      pending: false,
      lifecycle: 'existing',
      provenance: undefined,
    };
  }

  private immutableProvenance(provenance: ExactCodexProvenance): ExactCodexProvenance {
    return Object.freeze({
      confidence: provenance.confidence,
      threadId: provenance.threadId,
      turnId: provenance.turnId,
      itemIds: Object.freeze([...provenance.itemIds]),
    });
  }

  private async synchronizeView(key: string): Promise<void> {
    while (!this.disposed) {
      const state = this.snapshots.get(key);
      if (state === undefined || state.hunks.length === 0) {
        this.view.clear(key);
        return;
      }

      const { baselineText, currentText, hunks, sourceRevision } = state;
      await this.view.render(key, hunks);
      const current = this.snapshots.get(key);
      if (
        current?.sourceRevision === sourceRevision
        && current.baselineText === baselineText
        && current.currentText === currentText
        && current.hunks === hunks
      ) {
        return;
      }
    }
  }

  private nextRevision(key: string): number {
    const revision = (this.revisions.get(key) ?? this.snapshots.get(key)?.sourceRevision ?? 0) + 1;
    this.revisions.set(key, revision);
    return revision;
  }
}
