import { createHash } from 'node:crypto';
import { applyPatch, formatPatch, parsePatch, reversePatch } from 'diff';

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function applyUnifiedFilePatch(beforeText: string, patchText: string): string | undefined {
  try {
    const patched = applyPatch(beforeText, patchText, {
      fuzzFactor: 0,
      autoConvertLineEndings: false,
    });
    return patched === false ? undefined : patched;
  } catch {
    return undefined;
  }
}

export function reverseApplyUnifiedFilePatch(
  afterText: string,
  patchText: string,
): string | undefined {
  try {
    const parsed = parsePatch(patchText);
    if (parsed.length !== 1) {
      return undefined;
    }

    return applyUnifiedFilePatch(afterText, formatPatch(reversePatch(parsed[0])));
  } catch {
    return undefined;
  }
}
