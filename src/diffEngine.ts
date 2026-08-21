import { diffLines } from 'diff';
import { ChangeHunk, DiffEngine } from './types';

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

export class LineDiffEngine implements DiffEngine {
  compute(original: string, modified: string): readonly ChangeHunk[] {
    const changes = diffLines(
      normalizeLineEndings(original),
      normalizeLineEndings(modified),
      { newlineIsToken: false, ignoreNewlineAtEof: false },
    );
    const hunks: ChangeHunk[] = [];
    let originalLine = 0;
    let modifiedLine = 0;

    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index];
      const originalLines = toLines(change.value);

      if (change.removed && changes[index + 1]?.added) {
        const addedChange = changes[index + 1];
        const modifiedLines = toLines(addedChange.value);
        hunks.push({
          kind: 'modification',
          originalStart: originalLine,
          originalEnd: originalLine + originalLines.length,
          modifiedStart: modifiedLine,
          modifiedEnd: modifiedLine + modifiedLines.length,
          originalLines,
          modifiedLines,
        });
        originalLine += originalLines.length;
        modifiedLine += modifiedLines.length;
        index += 1;
        continue;
      }

      if (change.removed) {
        hunks.push({
          kind: 'deletion',
          originalStart: originalLine,
          originalEnd: originalLine + originalLines.length,
          modifiedStart: modifiedLine,
          modifiedEnd: modifiedLine,
          originalLines,
          modifiedLines: [],
        });
        originalLine += originalLines.length;
        continue;
      }

      if (change.added) {
        hunks.push({
          kind: 'addition',
          originalStart: originalLine,
          originalEnd: originalLine,
          modifiedStart: modifiedLine,
          modifiedEnd: modifiedLine + originalLines.length,
          originalLines: [],
          modifiedLines: originalLines,
        });
        modifiedLine += originalLines.length;
        continue;
      }

      originalLine += originalLines.length;
      modifiedLine += originalLines.length;
    }

    return hunks;
  }
}
