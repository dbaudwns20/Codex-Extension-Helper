import { createHash } from 'node:crypto';
import { applyPatch } from 'diff';

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
