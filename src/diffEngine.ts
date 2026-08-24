import { diffLines } from 'diff';
import { ChangeHunk, DiffEngine, type EofTerminator } from './types';

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function toLines(value: string): readonly string[] {
  if (value === '') {
    return [];
  }

  const content = value.endsWith('\n') ? value.slice(0, -1) : value;
  return content.split('\n');
}

function eofTerminator(text: string): EofTerminator {
  if (text.endsWith('\r\n')) {
    return '\r\n';
  }
  return text.endsWith('\n') ? '\n' : '';
}

export class LineDiffEngine implements DiffEngine {
  compute(original: string, modified: string): readonly ChangeHunk[] {
    const normalizedOriginal = normalizeLineEndings(original);
    const normalizedModified = normalizeLineEndings(modified);
    const changes = diffLines(
      normalizedOriginal,
      normalizedModified,
      { newlineIsToken: false, ignoreNewlineAtEof: false },
    );
    const originalLineCount = toLines(normalizedOriginal).length;
    const modifiedLineCount = toLines(normalizedModified).length;
    const originalEofTerminator = eofTerminator(original);
    const modifiedEofTerminator = eofTerminator(modified);
    const hunks: ChangeHunk[] = [];
    let originalLine = 0;
    let modifiedLine = 0;

    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index];
      const originalLines = toLines(change.value);

      if (change.removed && changes[index + 1]?.added) {
        const addedChange = changes[index + 1];
        const modifiedLines = toLines(addedChange.value);
        const hunk: ChangeHunk = {
          kind: 'modification',
          originalStart: originalLine,
          originalEnd: originalLine + originalLines.length,
          modifiedStart: modifiedLine,
          modifiedEnd: modifiedLine + modifiedLines.length,
          originalLines,
          modifiedLines,
        };
        hunks.push(this.withEofTerminators(
          hunk,
          originalLineCount,
          modifiedLineCount,
          originalEofTerminator,
          modifiedEofTerminator,
        ));
        originalLine += originalLines.length;
        modifiedLine += modifiedLines.length;
        index += 1;
        continue;
      }

      if (change.removed) {
        const hunk: ChangeHunk = {
          kind: 'deletion',
          originalStart: originalLine,
          originalEnd: originalLine + originalLines.length,
          modifiedStart: modifiedLine,
          modifiedEnd: modifiedLine,
          originalLines,
          modifiedLines: [],
        };
        hunks.push(this.withEofTerminators(
          hunk,
          originalLineCount,
          modifiedLineCount,
          originalEofTerminator,
          modifiedEofTerminator,
        ));
        originalLine += originalLines.length;
        continue;
      }

      if (change.added) {
        const hunk: ChangeHunk = {
          kind: 'addition',
          originalStart: originalLine,
          originalEnd: originalLine,
          modifiedStart: modifiedLine,
          modifiedEnd: modifiedLine + originalLines.length,
          originalLines: [],
          modifiedLines: originalLines,
        };
        hunks.push(this.withEofTerminators(
          hunk,
          originalLineCount,
          modifiedLineCount,
          originalEofTerminator,
          modifiedEofTerminator,
        ));
        modifiedLine += originalLines.length;
        continue;
      }

      originalLine += originalLines.length;
      modifiedLine += originalLines.length;
    }

    return hunks;
  }

  private withEofTerminators(
    hunk: ChangeHunk,
    originalLineCount: number,
    modifiedLineCount: number,
    originalEofTerminator: EofTerminator,
    modifiedEofTerminator: EofTerminator,
  ): ChangeHunk {
    if (
      hunk.originalEnd !== originalLineCount
      || hunk.modifiedEnd !== modifiedLineCount
    ) {
      return hunk;
    }
    return {
      ...hunk,
      originalEofTerminator,
      modifiedEofTerminator,
    };
  }
}
