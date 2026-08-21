export type ChangeKind = 'addition' | 'deletion' | 'modification';

export interface ChangeHunk {
  kind: ChangeKind;
  originalStart: number;
  originalEnd: number;
  modifiedStart: number;
  modifiedEnd: number;
  originalLines: readonly string[];
  modifiedLines: readonly string[];
}

export interface DiffEngine {
  compute(original: string, modified: string): readonly ChangeHunk[];
}
