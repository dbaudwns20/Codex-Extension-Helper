export type ChangeKind = 'addition' | 'deletion' | 'modification';
export type EofTerminator = '' | '\n' | '\r\n';
export type FileLifecycle = 'existing' | 'created' | 'deleted';

export interface ExactCodexProvenance {
  readonly confidence: 'exact';
  readonly threadId: string;
  readonly turnId: string;
  readonly itemIds: readonly string[];
}

export interface ChangeHunk {
  kind: ChangeKind;
  originalStart: number;
  originalEnd: number;
  modifiedStart: number;
  modifiedEnd: number;
  originalLines: readonly string[];
  modifiedLines: readonly string[];
  readonly originalEofTerminator?: EofTerminator;
  readonly modifiedEofTerminator?: EofTerminator;
}

export interface HunkReference {
  readonly key: string;
  readonly sourceRevision: number;
  readonly hunkIndex: number;
  readonly expectedText: string;
}

export interface FileComparisonState {
  baselineText: string;
  currentText: string;
  hunks: readonly ChangeHunk[];
  sourceRevision: number;
  comparisonActive: boolean;
  pending: boolean;
  readonly lifecycle: FileLifecycle;
  readonly provenance: ExactCodexProvenance | undefined;
}

export type ReviewStateResult =
  | { readonly status: 'ok'; readonly state: FileComparisonState }
  | { readonly status: 'missing' | 'stale' };

export interface DiffEngine {
  compute(original: string, modified: string): readonly ChangeHunk[];
}
