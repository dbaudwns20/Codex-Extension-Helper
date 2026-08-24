export interface DisplayEditChange {
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly text: string;
}

export interface DisplayEditExpectation {
  readonly key: string;
  readonly startingVersion: number;
  readonly originalText: string;
  readonly resultingText: string;
  readonly changes: readonly DisplayEditChange[];
}

export interface DisplayEditEvent {
  readonly key: string;
  readonly documentVersion: number;
  readonly originalText?: string;
  readonly resultingText: string;
  readonly changes: readonly DisplayEditChange[];
}

function sameChanges(
  first: readonly DisplayEditChange[],
  second: readonly DisplayEditChange[],
): boolean {
  return first.length === second.length && first.every((change, index) => {
    const candidate = second[index];
    return change.rangeOffset === candidate.rangeOffset
      && change.rangeLength === candidate.rangeLength
      && change.text === candidate.text;
  });
}

export class DisplayEditFence {
  private readonly pending = new Map<string, DisplayEditExpectation>();

  begin(expectation: DisplayEditExpectation): () => void {
    this.pending.set(expectation.key, expectation);
    let finished = false;
    return () => {
      if (!finished && this.pending.get(expectation.key) === expectation) {
        this.pending.delete(expectation.key);
      }
      finished = true;
    };
  }

  consume(event: DisplayEditEvent): boolean {
    const expectation = this.pending.get(event.key);
    if (expectation === undefined) {
      return false;
    }
    this.pending.delete(event.key);
    return event.documentVersion === expectation.startingVersion + 1
      && (event.originalText === undefined || event.originalText === expectation.originalText)
      && event.resultingText === expectation.resultingText
      && sameChanges(event.changes, expectation.changes);
  }

  invalidate(key: string): void {
    this.pending.delete(key);
  }

  clear(): void {
    this.pending.clear();
  }
}
