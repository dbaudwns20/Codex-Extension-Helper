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

const timestampedCompleted = (emittedAtMs: unknown, completedAtMs: unknown) => ({
  method: 'item/completed',
  emittedAtMs,
  params: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    completedAtMs,
    item: {
      id: 'item-1',
      type: 'fileChange',
      status: 'completed',
      changes: [change],
    },
  },
});

describe('parseCodexProvenanceNotification', () => {
  it('accepts the current timestamped completed notification envelope', () => {
    expect(parseCodexProvenanceNotification(timestampedCompleted(
      1_777_777_777_000,
      1_777_777_776_000,
    ))).toMatchObject({
      method: 'item/completed',
      params: { item: { status: 'completed' } },
    });
  });

  it.each([
    ['emission', -1, 1_777_777_776_000],
    ['completion', 1_777_777_777_000, 1.5],
  ])('rejects an invalid %s timestamp', (_label, emittedAtMs, completedAtMs) => {
    expect(parseCodexProvenanceNotification(
      timestampedCompleted(emittedAtMs, completedAtMs),
    )).toBeUndefined();
  });

  it('accepts a valid patch update', () => {
    expect(parseCodexProvenanceNotification(patchUpdated())).toMatchObject({
      method: 'item/fileChange/patchUpdated',
    });
  });

  it('accepts the absolute POSIX path emitted by the current Codex extension', () => {
    const path = '/workspace/src/file.ts';

    expect(parseCodexProvenanceNotification(patchUpdated({
      changes: [{ ...change, path }],
    }))).toMatchObject({
      params: { changes: [{ path }] },
    });
  });

  it.each(['completed', 'failed', 'declined', 'interrupted'] as const)(
    'retains the exact %s terminal file-change status',
    (status) => {
      const parsed = parseCodexProvenanceNotification(completed(status));

      expect(parsed).toMatchObject({
        method: 'item/completed',
        params: { item: { status } },
      });
      expect(parsed?.method === 'item/completed' && parsed.params.item.status).toBe(status);
    },
  );

  it('rejects non-terminal and non-file completed items', () => {
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
    for (const path of ['', '../escape.ts', 'src/../escape.ts', 'src\\file.ts', 'src/\u0000.ts']) {
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
