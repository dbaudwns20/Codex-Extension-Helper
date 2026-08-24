export type ChangeKind = 'addition' | 'deletion' | 'modification';
export type EofTerminator = '' | '\n' | '\r\n';

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
  createdFile: boolean;
}

export type ReviewStateResult =
  | { readonly status: 'ok'; readonly state: FileComparisonState }
  | { readonly status: 'missing' | 'stale' };

export interface DiffEngine {
  compute(original: string, modified: string): readonly ChangeHunk[];
}
