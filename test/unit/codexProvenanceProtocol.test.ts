import { describe, expect, it } from 'vitest';
import {
  parseCodexProvenanceNotification,
  type CodexFileUpdateChange,
} from '../../src/codexProvenanceProtocol';

const change: CodexFileUpdateChange = {
  path: 'src/file.ts',
  kind: { type: 'update', move_path: null },
  diff: '@@ -1 +1 @@\n-old\n+new\n',
};

const patchUpdated = (overrides: Record<string, unknown> = {}) => ({
  method: 'item/fileChange/patchUpdated',
  params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', changes: [change], ...overrides },
});

const completed = (status = 'completed', overrides: Record<string, unknown> = {}) => ({
  method: 'item/completed',
  params: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { id: 'item-1', type: 'fileChange', status, changes: [change], ...overrides },
  },
});

describe('parseCodexProvenanceNotification', () => {
  it('accepts a valid patch update', () => {
    expect(parseCodexProvenanceNotification(patchUpdated())).toMatchObject({
      method: 'item/fileChange/patchUpdated',
    });
  });

  it('accepts completed and terminal invalidation file-change items', () => {
    expect(parseCodexProvenanceNotification(completed())).toMatchObject({ method: 'item/completed' });
    for (const status of ['failed', 'declined', 'interrupted']) {
      expect(parseCodexProvenanceNotification(completed(status))).toMatchObject({ method: 'item/completed' });
    }
    expect(parseCodexProvenanceNotification(completed('in_progress'))).toBeUndefined();
    expect(parseCodexProvenanceNotification(completed('completed', { type: 'commandExecution' }))).toBeUndefined();
  });

  it('rejects missing identifiers, unknown methods, and malformed payloads', () => {
    expect(parseCodexProvenanceNotification(patchUpdated({ itemId: '' }))).toBeUndefined();
    expect(parseCodexProvenanceNotification(patchUpdated({ threadId: undefined }))).toBeUndefined();
    expect(parseCodexProvenanceNotification({ method: 'unknown', params: {} })).toBeUndefined();
    expect(parseCodexProvenanceNotification(null)).toBeUndefined();
  });

  it('rejects invalid paths and extra or invalid kind fields', () => {
    for (const path of ['', '/absolute.ts', '../escape.ts', 'src/../escape.ts', 'src\\file.ts', 'src/\u0000.ts']) {
      expect(parseCodexProvenanceNotification(patchUpdated({ changes: [{ ...change, path }] }))).toBeUndefined();
    }
    expect(parseCodexProvenanceNotification(patchUpdated({
      changes: [{ ...change, kind: { type: 'add', extra: true } }],
    }))).toBeUndefined();
    expect(parseCodexProvenanceNotification(patchUpdated({
      changes: [{ ...change, kind: { type: 'update', move_path: 3 } }],
    }))).toBeUndefined();
    expect(parseCodexProvenanceNotification(patchUpdated({
      changes: [{ ...change, kind: { type: 'rename' } }],
    }))).toBeUndefined();
  });

  it('rejects too many changes and oversized UTF-8 diffs', () => {
    expect(parseCodexProvenanceNotification(patchUpdated({ changes: [change, change] }), {
      maxChanges: 1,
      maxDiffBytes: 100,
    })).toBeUndefined();
    expect(parseCodexProvenanceNotification(patchUpdated({
      changes: [{ ...change, diff: '한'.repeat(50) }],
    }), { maxChanges: 1, maxDiffBytes: 100 })).toBeUndefined();
  });
});
