export interface LiveDocumentSnapshot {
  readonly version: number;
  readonly text: string;
  readonly isDirty: boolean;
}

export interface DocumentChangeToken {
  readonly key: string;
  readonly generation: number;
  readonly expectedText: string;
  readonly documentVersion: number | undefined;
}

export function shouldInvalidateDocumentChange(
  contentChangeCount: number,
  isDirty: boolean,
): boolean {
  return contentChangeCount > 0 && isDirty;
}

export class DocumentChangeFence {
  private readonly generations = new Map<string, number>();

  capture(
    key: string,
    expectedText: string,
    document?: LiveDocumentSnapshot,
  ): DocumentChangeToken {
    return {
      key,
      generation: this.generations.get(key) ?? 0,
      expectedText,
      documentVersion: document?.version,
    };
  }

  invalidate(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  isCurrent(
    token: DocumentChangeToken,
    document?: LiveDocumentSnapshot,
  ): boolean {
    if ((this.generations.get(token.key) ?? 0) !== token.generation) {
      return false;
    }

    if (document === undefined) {
      return true;
    }

    if (document.text !== token.expectedText) {
      return false;
    }

    return token.documentVersion === undefined
      || document.version === token.documentVersion
      || !document.isDirty;
  }

  clear(): void {
    this.generations.clear();
  }
}
