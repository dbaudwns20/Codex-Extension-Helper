import type { ChangeHunk } from './types';

export interface SpacerTextEdit {
  readonly offset: number;
  readonly length: number;
  readonly text: string;
}

export interface SpacerSpan {
  readonly displayStart: number;
  readonly displayEnd: number;
  readonly text: string;
  readonly hunkIndex: number;
  readonly originalLineIndex: number;
  readonly displayLine: number;
}

export interface DisplayHunkMapping {
  readonly hunkIndex: number;
  readonly actionLine: number;
  readonly removedRows: readonly {
    readonly line: number;
    readonly text: string;
  }[];
  readonly modifiedStart: number;
  readonly modifiedEnd: number;
}

export interface TemporaryLineSpacerPlan {
  readonly canonicalText: string;
  readonly displayText: string;
  readonly eol: '\n' | '\r\n';
  readonly insertions: readonly SpacerTextEdit[];
  readonly spans: readonly SpacerSpan[];
  readonly hunks: readonly DisplayHunkMapping[];
  displayLineForCanonical(line: number): number;
}

export interface DisplayContentChange {
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly text: string;
}

export interface SpacerReconciliation {
  readonly textAfterUserEdit: string;
  readonly canonicalizedText: string;
  readonly cleanupEdits: readonly SpacerTextEdit[];
  readonly intersectedSpacerCount: number;
}

interface PendingHunkInsertion {
  readonly hunkIndex: number;
  readonly canonicalLine: number;
  readonly offset: number;
  readonly lines: readonly string[];
}

interface InsertionGroup {
  readonly offset: number;
  readonly canonicalLine: number;
  readonly hunks: readonly PendingHunkInsertion[];
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

function offsetForLine(text: string, starts: readonly number[], line: number): number {
  if (line <= 0) {
    return 0;
  }
  if (line >= starts.length) {
    return text.length;
  }
  return starts[line];
}

function applyTextEdits(text: string, edits: readonly SpacerTextEdit[]): string | undefined {
  const ordered = [...edits].sort((left, right) => right.offset - left.offset);
  let previousOffset = text.length + 1;
  let result = text;
  for (const edit of ordered) {
    if (
      !Number.isSafeInteger(edit.offset)
      || !Number.isSafeInteger(edit.length)
      || edit.offset < 0
      || edit.length < 0
      || edit.offset + edit.length > text.length
      || edit.offset + edit.length > previousOffset
    ) {
      return undefined;
    }
    result = result.slice(0, edit.offset)
      + edit.text
      + result.slice(edit.offset + edit.length);
    previousOffset = edit.offset;
  }
  return result;
}

export function createTemporaryLineSpacerPlan(
  canonicalText: string,
  eol: '\n' | '\r\n',
  hunks: readonly ChangeHunk[],
): TemporaryLineSpacerPlan {
  const starts = lineStarts(canonicalText);
  const pending = hunks.flatMap((hunk, hunkIndex): PendingHunkInsertion[] => {
    if (hunk.originalLines.length === 0) {
      return [];
    }
    const canonicalLine = Math.max(0, Math.min(hunk.modifiedStart, starts.length));
    return [{
      hunkIndex,
      canonicalLine,
      offset: offsetForLine(canonicalText, starts, canonicalLine),
      lines: hunk.originalLines,
    }];
  });

  const grouped = new Map<number, PendingHunkInsertion[]>();
  for (const insertion of pending) {
    const existing = grouped.get(insertion.offset);
    if (existing === undefined) {
      grouped.set(insertion.offset, [insertion]);
    } else {
      existing.push(insertion);
    }
  }
  const groups: InsertionGroup[] = [...grouped.entries()]
    .map(([offset, groupedHunks]) => ({
      offset,
      canonicalLine: Math.min(...groupedHunks.map((hunk) => hunk.canonicalLine)),
      hunks: [...groupedHunks].sort((left, right) => left.hunkIndex - right.hunkIndex),
    }))
    .sort((left, right) => left.offset - right.offset);

  const insertions = groups
    .map((group): SpacerTextEdit => ({
      offset: group.offset,
      length: 0,
      text: eol.repeat(group.hunks.reduce((count, hunk) => count + hunk.lines.length, 0)),
    }))
    .sort((left, right) => right.offset - left.offset);
  const displayText = applyTextEdits(canonicalText, insertions) ?? canonicalText;

  const spans: SpacerSpan[] = [];
  const removedRowsByHunk = new Map<number, { line: number; text: string }[]>();
  let canonicalCursor = 0;
  let displayCursor = 0;
  let insertedLines = 0;
  for (const group of groups) {
    const prefix = canonicalText.slice(canonicalCursor, group.offset);
    displayCursor += prefix.length;
    canonicalCursor = group.offset;

    const offsetIsLineStart = group.offset === 0 || canonicalText[group.offset - 1] === '\n';
    let displayLine = group.canonicalLine + insertedLines + (offsetIsLineStart ? 0 : 1);
    for (const hunk of group.hunks) {
      const rows = removedRowsByHunk.get(hunk.hunkIndex) ?? [];
      for (let originalLineIndex = 0; originalLineIndex < hunk.lines.length; originalLineIndex += 1) {
        spans.push({
          displayStart: displayCursor,
          displayEnd: displayCursor + eol.length,
          text: eol,
          hunkIndex: hunk.hunkIndex,
          originalLineIndex,
          displayLine,
        });
        rows.push({ line: displayLine, text: hunk.lines[originalLineIndex] });
        displayCursor += eol.length;
        displayLine += 1;
        insertedLines += 1;
      }
      removedRowsByHunk.set(hunk.hunkIndex, rows);
    }
  }

  const insertedBefore = (line: number, includeSameLine: boolean): number => groups.reduce(
    (count, group) => {
      const applies = includeSameLine
        ? group.canonicalLine <= line
        : group.canonicalLine < line;
      return count + (applies
        ? group.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
        : 0);
    },
    0,
  );
  const displayLineForCanonical = (line: number): number => {
    const canonicalLine = Math.max(0, line);
    return canonicalLine + insertedBefore(canonicalLine, true);
  };

  const mappedHunks = hunks.map((hunk, hunkIndex): DisplayHunkMapping => {
    const removedRows = removedRowsByHunk.get(hunkIndex) ?? [];
    const modifiedStart = Math.max(0, hunk.modifiedStart)
      + insertedBefore(Math.max(0, hunk.modifiedStart), true);
    const modifiedEnd = Math.max(0, hunk.modifiedEnd)
      + insertedBefore(Math.max(0, hunk.modifiedEnd), false);
    return {
      hunkIndex,
      actionLine: removedRows[0]?.line ?? modifiedStart,
      removedRows,
      modifiedStart,
      modifiedEnd: Math.max(modifiedStart, modifiedEnd),
    };
  });

  return {
    canonicalText,
    displayText,
    eol,
    insertions,
    spans,
    hunks: mappedHunks,
    displayLineForCanonical,
  };
}

function changeIntersectsSpan(change: DisplayContentChange, span: SpacerSpan): boolean {
  const changeEnd = change.rangeOffset + change.rangeLength;
  if (change.rangeLength === 0) {
    return change.rangeOffset >= span.displayStart && change.rangeOffset < span.displayEnd;
  }
  return change.rangeOffset < span.displayEnd && changeEnd > span.displayStart;
}

function rebasedOffset(
  offset: number,
  changes: readonly DisplayContentChange[],
): number {
  return changes.reduce((result, change) => {
    const changeEnd = change.rangeOffset + change.rangeLength;
    return changeEnd <= offset
      ? result + change.text.length - change.rangeLength
      : result;
  }, offset);
}

export function reconcileSpacerEdit(
  plan: TemporaryLineSpacerPlan,
  changes: readonly DisplayContentChange[],
): SpacerReconciliation | undefined {
  const ordered = [...changes].sort((left, right) => left.rangeOffset - right.rangeOffset);
  let previousEnd = 0;
  for (const change of ordered) {
    if (
      !Number.isSafeInteger(change.rangeOffset)
      || !Number.isSafeInteger(change.rangeLength)
      || change.rangeOffset < 0
      || change.rangeLength < 0
      || change.rangeOffset + change.rangeLength > plan.displayText.length
      || change.rangeOffset < previousEnd
    ) {
      return undefined;
    }
    previousEnd = change.rangeOffset + change.rangeLength;
  }

  const userEdits: SpacerTextEdit[] = ordered.map((change) => ({
    offset: change.rangeOffset,
    length: change.rangeLength,
    text: change.text,
  }));
  const textAfterUserEdit = applyTextEdits(plan.displayText, userEdits);
  if (textAfterUserEdit === undefined) {
    return undefined;
  }

  let intersectedSpacerCount = 0;
  const cleanupEdits: SpacerTextEdit[] = [];
  for (const span of plan.spans) {
    if (ordered.some((change) => changeIntersectsSpan(change, span))) {
      intersectedSpacerCount += 1;
      continue;
    }
    const offset = rebasedOffset(span.displayStart, ordered);
    if (textAfterUserEdit.slice(offset, offset + span.text.length) !== span.text) {
      return undefined;
    }
    cleanupEdits.push({ offset, length: span.text.length, text: '' });
  }
  cleanupEdits.sort((left, right) => right.offset - left.offset);
  const canonicalizedText = applyTextEdits(textAfterUserEdit, cleanupEdits);
  if (canonicalizedText === undefined) {
    return undefined;
  }

  return {
    textAfterUserEdit,
    canonicalizedText,
    cleanupEdits,
    intersectedSpacerCount,
  };
}
