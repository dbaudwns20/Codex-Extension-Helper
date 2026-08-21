import { describe, expect, it } from 'vitest';
import {
  DocumentChangeFence,
  shouldInvalidateDocumentChange,
  type LiveDocumentSnapshot,
} from '../../src/documentChangeFence';

function document(
  version: number,
  text: string,
  isDirty: boolean,
): LiveDocumentSnapshot {
  return { version, text, isDirty };
}

describe('DocumentChangeFence', () => {
  const key = 'file:///workspace/file.ts';

  it('invalidates a captured comparison synchronously for a user document change', () => {
    const fence = new DocumentChangeFence();
    const token = fence.capture(key, 'disk result', document(1, 'disk result', false));

    fence.invalidate(key);

    expect(fence.isCurrent(token, document(2, 'user edit', true))).toBe(false);
  });

  it('rejects a live document whose text no longer matches the comparison input', () => {
    const fence = new DocumentChangeFence();
    const token = fence.capture(key, 'disk result', document(1, 'disk result', false));

    expect(fence.isCurrent(token, document(1, 'different buffer', false))).toBe(false);
  });

  it('allows the same external text after a non-dirty document refresh', () => {
    const fence = new DocumentChangeFence();
    const token = fence.capture(key, 'disk result', document(1, 'disk result', false));

    expect(fence.isCurrent(token, document(2, 'disk result', false))).toBe(true);
  });

  it('validates a document opened while a background comparison is running', () => {
    const fence = new DocumentChangeFence();
    const token = fence.capture(key, 'disk result');

    expect(fence.isCurrent(token, document(1, 'disk result', false))).toBe(true);
    expect(fence.isCurrent(token, document(1, 'user edit', true))).toBe(false);
  });

  it('invalidates only user-dirty content changes, not external non-dirty refreshes', () => {
    expect(shouldInvalidateDocumentChange(1, true)).toBe(true);
    expect(shouldInvalidateDocumentChange(1, false)).toBe(false);
    expect(shouldInvalidateDocumentChange(0, true)).toBe(false);
  });
});
