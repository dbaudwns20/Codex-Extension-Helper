import type { FileComparisonState } from './types';

export type { FileComparisonState } from './types';

export class SnapshotStore {
  private readonly states = new Map<string, FileComparisonState>();
  private readonly acceptedTexts = new Map<string, string>();

  get(key: string): FileComparisonState | undefined {
    return this.states.get(key);
  }

  acceptedText(key: string): string | undefined {
    return this.acceptedTexts.get(key);
  }

  seed(key: string, text: string): void {
    this.acceptedTexts.set(key, text);
    this.states.set(key, this.acceptedState(text));
  }

  setComparison(key: string, state: FileComparisonState): void {
    this.states.set(key, state);
  }

  accept(key: string, text: string): void {
    const sourceRevision = this.states.get(key)?.sourceRevision;
    this.acceptedTexts.set(key, text);
    this.states.set(key, this.acceptedState(text, sourceRevision === undefined ? 0 : sourceRevision + 1));
  }

  setAcceptedText(key: string, text: string): void {
    this.acceptedTexts.set(key, text);
  }

  delete(key: string): void {
    this.acceptedTexts.delete(key);
    this.states.delete(key);
  }

  clear(): void {
    this.acceptedTexts.clear();
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
      lifecycle: 'existing',
      provenance: undefined,
    };
  }
}
