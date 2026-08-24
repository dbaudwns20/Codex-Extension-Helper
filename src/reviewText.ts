import type { ChangeHunk, EofTerminator } from './types';

export interface TextReplacement {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly replacementText: string;
}

interface LineLocation {
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly terminatorEnd: number;
}

function lineTable(text: string): readonly LineLocation[] {
  if (text.length === 0) {
    return [];
  }

  const lines: LineLocation[] = [];
  let contentStart = 0;

  while (contentStart < text.length) {
    const newlineIndex = text.indexOf('\n', contentStart);
    if (newlineIndex < 0) {
      lines.push({
        contentStart,
        contentEnd: text.length,
        terminatorEnd: text.length,
      });
      break;
    }

    const hasCarriageReturn = newlineIndex > contentStart
      && text[newlineIndex - 1] === '\r';
    lines.push({
      contentStart,
      contentEnd: hasCarriageReturn ? newlineIndex - 1 : newlineIndex,
      terminatorEnd: newlineIndex + 1,
    });
    contentStart = newlineIndex + 1;
  }

  return lines;
}

function detectedEol(text: string): string {
  const newlineIndex = text.indexOf('\n');
  if (newlineIndex < 0) {
    return '\n';
  }
  return newlineIndex > 0 && text[newlineIndex - 1] === '\r' ? '\r\n' : '\n';
}

function clampLine(line: number, lineCount: number): number {
  return Math.max(0, Math.min(line, lineCount));
}

function boundaryOffset(
  text: string,
  lines: readonly LineLocation[],
  line: number,
): number {
  const index = clampLine(line, lines.length);
  return index < lines.length ? lines[index].contentStart : text.length;
}

function replacementRange(
  text: string,
  lines: readonly LineLocation[],
  startLine: number,
  endLine: number,
): { startOffset: number; endOffset: number; hasTrailingEol: boolean } {
  const start = clampLine(startLine, lines.length);
  const end = clampLine(endLine, lines.length);
  const startOffset = boundaryOffset(text, lines, start);
  if (end <= start) {
    return { startOffset, endOffset: startOffset, hasTrailingEol: false };
  }

  const lastLine = lines[end - 1];
  return {
    startOffset,
    endOffset: lastLine.terminatorEnd,
    hasTrailingEol: lastLine.terminatorEnd > lastLine.contentEnd,
  };
}

function encodeLines(
  lines: readonly string[],
  eol: string,
  location: { hasTrailingEol: boolean },
): string {
  if (lines.length === 0) {
    return '';
  }
  const replacement = lines.join(eol);
  return location.hasTrailingEol ? replacement + eol : replacement;
}

function encodeInsertion(
  text: string,
  lines: readonly LineLocation[],
  line: number,
  replacementLines: readonly string[],
  eol: string,
): string {
  if (replacementLines.length === 0) {
    return '';
  }

  const index = clampLine(line, lines.length);
  const replacement = replacementLines.join(eol);
  if (index < lines.length || text.endsWith('\n')) {
    return replacement + eol;
  }
  return text.length === 0 ? replacement : eol + replacement;
}

function applyHunk(
  text: string,
  startLine: number,
  endLine: number,
  replacementLines: readonly string[],
): TextReplacement & { replacementText: string } {
  const lines = lineTable(text);
  const eol = detectedEol(text);
  const location = replacementRange(text, lines, startLine, endLine);
  const replacementText = location.startOffset === location.endOffset
    ? encodeInsertion(text, lines, startLine, replacementLines, eol)
    : encodeLines(replacementLines, eol, location);
  return {
    startOffset: location.startOffset,
    endOffset: location.endOffset,
    replacementText,
  };
}

function replaceEofTerminator(text: string, terminator: EofTerminator): string {
  const content = text.endsWith('\r\n')
    ? text.slice(0, -2)
    : text.endsWith('\n')
      ? text.slice(0, -1)
      : text;
  return content + terminator;
}

function commonPrefixOffset(first: string, second: string): number {
  let offset = 0;
  while (offset < first.length && offset < second.length) {
    const firstCodePoint = first.codePointAt(offset);
    if (firstCodePoint !== second.codePointAt(offset)) {
      break;
    }
    offset += firstCodePoint !== undefined && firstCodePoint > 0xFFFF ? 2 : 1;
  }
  return offset;
}

function replacementToTarget(currentText: string, targetText: string): TextReplacement {
  const startOffset = commonPrefixOffset(currentText, targetText);
  return {
    startOffset,
    endOffset: currentText.length,
    replacementText: targetText.slice(startOffset),
  };
}

export function applyApprovedHunk(
  baselineText: string,
  hunk: ChangeHunk,
): string {
  const patch = applyHunk(
    baselineText,
    hunk.originalStart,
    hunk.originalEnd,
    hunk.modifiedLines,
  );
  const approvedText = baselineText.slice(0, patch.startOffset)
    + patch.replacementText
    + baselineText.slice(patch.endOffset);
  return hunk.modifiedEofTerminator === undefined
    ? approvedText
    : replaceEofTerminator(approvedText, hunk.modifiedEofTerminator);
}

export function rejectedHunkReplacement(
  currentText: string,
  hunk: ChangeHunk,
): TextReplacement {
  const patch = applyHunk(
    currentText,
    hunk.modifiedStart,
    hunk.modifiedEnd,
    hunk.originalLines,
  );
  if (hunk.originalEofTerminator === undefined) {
    return patch;
  }

  const rejectedText = currentText.slice(0, patch.startOffset)
    + patch.replacementText
    + currentText.slice(patch.endOffset);
  return replacementToTarget(
    currentText,
    replaceEofTerminator(rejectedText, hunk.originalEofTerminator),
  );
}
