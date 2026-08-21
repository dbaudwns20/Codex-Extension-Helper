import type { ChangeHunk } from './types';

export interface FileComparisonState {
  baselineText: string;
  currentText: string;
  hunks: readonly ChangeHunk[];
  sourceRevision: number;
  comparisonActive: boolean;
  pending: boolean;
}

export class SnapshotStore {
  private readonly states = new Map<string, FileComparisonState>();

  get(key: string): FileComparisonState | undefined {
    return this.states.get(key);
  }

  seed(key: string, text: string): void {
    this.states.set(key, this.acceptedState(text));
  }

  setComparison(key: string, state: FileComparisonState): void {
    this.states.set(key, state);
  }

  accept(key: string, text: string): void {
    const sourceRevision = this.states.get(key)?.sourceRevision;
    this.states.set(key, this.acceptedState(text, sourceRevision === undefined ? 0 : sourceRevision + 1));
  }

  delete(key: string): void {
    this.states.delete(key);
  }

  clear(): void {
    this.states.clear();
  }

  private acceptedState(text: string, sourceRevision = 0): FileComparisonState {
    return {
      baselineText: text,
      currentText: text,
      hunks: [],
      sourceRevision,
      comparisonActive: false,
      pending: false,
    };
  }
}
