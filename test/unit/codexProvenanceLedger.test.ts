import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  CodexProvenanceLedger,
  type ProvenanceFileState,
} from '../../src/codexProvenanceLedger';
import type {
  CodexFileChangeStatus,
  CodexFileUpdateChange,
  CodexProvenanceNotification,
} from '../../src/codexProvenanceProtocol';

const NEW_HASH = '7aa7a5359173d05b63cfd682e3c38487f3cb4f7f1d60659fe59fab1505977d4c';
const FINAL_HASH = '9149a1639fd729ca74b4353844d37528182883bc3b68bda8c864cd7064dd1043';

function fakeUri(path: string): vscode.Uri {
  return { toString: () => `file:///workspace/${path}` } as vscode.Uri;
}

function state(path: string, exists: boolean, text = ''): ProvenanceFileState {
  return { uri: fakeUri(path), exists, text };
}

function accepted(states: Record<string, ProvenanceFileState>) {
  return (path: string): ProvenanceFileState | undefined => states[path];
}

function update(path: string, before: string, after: string): CodexFileUpdateChange {
  return {
    path,
    kind: { type: 'update', move_path: null },
    diff: [
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1 +1 @@',
      `-${before}`,
      `+${after}`,
      '',
    ].join('\n'),
  };
}

function add(path: string, text: string): CodexFileUpdateChange {
  return {
    path,
    kind: { type: 'add' },
    diff: [
      '--- /dev/null',
      `+++ b/${path}`,
      '@@ -0,0 +1 @@',
      `+${text}`,
      '',
    ].join('\n'),
  };
}

function remove(path: string, text: string): CodexFileUpdateChange {
  return {
    path,
    kind: { type: 'delete' },
    diff: [
      `--- a/${path}`,
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      `-${text}`,
      '',
    ].join('\n'),
  };
}

function patchUpdated(
  changes: readonly CodexFileUpdateChange[],
  itemId = 'item-1',
  threadId = 'thread-1',
  turnId = 'turn-1',
): CodexProvenanceNotification {
  return {
    method: 'item/fileChange/patchUpdated',
    params: { threadId, turnId, itemId, changes },
  };
}

function completed(
  changes: readonly CodexFileUpdateChange[],
  itemId = 'item-1',
  status: CodexFileChangeStatus = 'completed',
  threadId = 'thread-1',
  turnId = 'turn-1',
): CodexProvenanceNotification {
  return {
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: { id: itemId, type: 'fileChange', status, changes },
    },
  };
}

describe('CodexProvenanceLedger', () => {
  it('waits for completion after receiving a patch update', () => {
    const ledger = new CodexProvenanceLedger();
    const change = update('file.txt', 'old', 'new');
    const resolveAcceptedPath = accepted({ 'file.txt': state('file.txt', true, 'old\n') });

    ledger.record(patchUpdated([change]));
    expect(ledger.completedTransitions(resolveAcceptedPath)).toEqual([]);

    ledger.record(completed([change]));
    expect(ledger.completedTransitions(resolveAcceptedPath)).toEqual([{
      key: 'file:///workspace/file.txt',
      uri: expect.any(Object),
      before: expect.objectContaining({ exists: true, text: 'old\n' }),
      after: expect.objectContaining({ exists: true, text: 'new\n' }),
      provenance: {
        confidence: 'exact',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemIds: ['item-1'],
      },
    }]);
  });

  it('uses the completion payload as the authoritative final patch revision', () => {
    const ledger = new CodexProvenanceLedger();
    ledger.record(patchUpdated([update('file.txt', 'old', 'new')]));
    ledger.record(completed([update('file.txt', 'old', 'final')]));

    const [transition] = ledger.completedTransitions(accepted({
      'file.txt': state('file.txt', true, 'old\n'),
    }));

    expect(transition.after.text).toBe('final\n');
    expect(ledger.consume(transition.key, FINAL_HASH)).toBe(transition);
  });

  it('is idempotent for identical notifications and fails closed for conflicting terminal payloads', () => {
    const ledger = new CodexProvenanceLedger();
    const change = update('file.txt', 'old', 'new');
    const notification = completed([change]);
    ledger.record(patchUpdated([change]));
    ledger.record(patchUpdated([change]));
    ledger.record(notification);
    ledger.record(notification);

    const resolveAcceptedPath = accepted({ 'file.txt': state('file.txt', true, 'old\n') });
    expect(ledger.completedTransitions(resolveAcceptedPath)).toHaveLength(1);

    ledger.record(completed([update('file.txt', 'old', 'final')]));
    expect(ledger.completedTransitions(resolveAcceptedPath)).toEqual([]);
    expect(ledger.consume('file:///workspace/file.txt', NEW_HASH)).toBeUndefined();
  });

  it('fails closed when a post-completion patch update conflicts with the authoritative payload', () => {
    const ledger = new CodexProvenanceLedger();
    ledger.record(completed([update('file.txt', 'old', 'new')]));
    ledger.record(patchUpdated([update('file.txt', 'old', 'final')]));

    expect(ledger.completedTransitions(accepted({
      'file.txt': state('file.txt', true, 'old\n'),
    }))).toEqual([]);
  });

  it.each(['failed', 'declined', 'interrupted'] as const)(
    '%s terminal status invalidates completed evidence for the same item and path',
    (status) => {
      const ledger = new CodexProvenanceLedger();
      const change = update('file.txt', 'old', 'new');
      ledger.record(completed([change]));
      ledger.record(completed([change], 'item-1', status));

      expect(ledger.completedTransitions(accepted({
        'file.txt': state('file.txt', true, 'old\n'),
      }))).toEqual([]);
    },
  );

  it('keeps item identity isolated by thread, turn, and item identifiers', () => {
    const ledger = new CodexProvenanceLedger();
    ledger.record(completed([update('a.txt', 'old', 'new')], 'shared', 'completed', 'thread-a', 'turn-a'));
    ledger.record(completed([update('b.txt', 'old', 'new')], 'shared', 'completed', 'thread-b', 'turn-b'));

    const transitions = ledger.completedTransitions(accepted({
      'a.txt': state('a.txt', true, 'old\n'),
      'b.txt': state('b.txt', true, 'old\n'),
    }));

    expect(transitions.map(({ key, provenance }) => ({ key, provenance }))).toEqual([
      {
        key: 'file:///workspace/a.txt',
        provenance: { confidence: 'exact', threadId: 'thread-a', turnId: 'turn-a', itemIds: ['shared'] },
      },
      {
        key: 'file:///workspace/b.txt',
        provenance: { confidence: 'exact', threadId: 'thread-b', turnId: 'turn-b', itemIds: ['shared'] },
      },
    ]);
  });

  it('produces independent transitions when one completed item changes several files', () => {
    const ledger = new CodexProvenanceLedger();
    ledger.record(completed([
      update('a.txt', 'old', 'new'),
      update('b.txt', 'alpha', 'beta'),
    ]));

    const resolveAcceptedPath = accepted({
      'a.txt': state('a.txt', true, 'old\n'),
      'b.txt': state('b.txt', true, 'alpha\n'),
    });
    const transitions = ledger.completedTransitions(resolveAcceptedPath);

    expect(transitions.map((transition) => [transition.key, transition.after.text])).toEqual([
      ['file:///workspace/a.txt', 'new\n'],
      ['file:///workspace/b.txt', 'beta\n'],
    ]);

    expect(ledger.consume('file:///workspace/a.txt', NEW_HASH)?.after.text).toBe('new\n');
    expect(ledger.completedTransitions(resolveAcceptedPath).map(({ key }) => key)).toEqual([
      'file:///workspace/b.txt',
    ]);
  });

  it('collapses sequential completed items into one exact hash-linked transition', () => {
    const ledger = new CodexProvenanceLedger();
    ledger.record(completed([update('file.txt', 'old', 'new')], 'item-1'));
    ledger.record(completed([update('file.txt', 'new', 'final')], 'item-2'));

    const [transition] = ledger.completedTransitions(accepted({
      'file.txt': state('file.txt', true, 'old\n'),
    }));

    expect(transition.before.text).toBe('old\n');
    expect(transition.after.text).toBe('final\n');
    expect(transition.provenance.itemIds).toEqual(['item-1', 'item-2']);
  });

  it('replays exact add, update, and delete lifecycles', () => {
    const additions = new CodexProvenanceLedger();
    additions.record(completed([add('added.txt', 'one')]));
    expect(additions.completedTransitions(accepted({
      'added.txt': state('added.txt', false),
    }))[0]).toMatchObject({
      before: { exists: false, text: '' },
      after: { exists: true, text: 'one\n' },
    });

    const updates = new CodexProvenanceLedger();
    updates.record(completed([update('updated.txt', 'one', 'two')]));
    expect(updates.completedTransitions(accepted({
      'updated.txt': state('updated.txt', true, 'one\n'),
    }))[0]).toMatchObject({
      before: { exists: true, text: 'one\n' },
      after: { exists: true, text: 'two\n' },
    });

    const deletions = new CodexProvenanceLedger();
    deletions.record(completed([remove('deleted.txt', 'one')]));
    expect(deletions.completedTransitions(accepted({
      'deleted.txt': state('deleted.txt', true, 'one\n'),
    }))[0]).toMatchObject({
      before: { exists: true, text: 'one\n' },
      after: { exists: false, text: '' },
    });
  });

  it('hash-links an add-update-delete sequence from accepted absence back to absence', () => {
    const ledger = new CodexProvenanceLedger();
    ledger.record(completed([add('file.txt', 'one')], 'add'));
    ledger.record(completed([update('file.txt', 'one', 'two')], 'update'));
    ledger.record(completed([remove('file.txt', 'two')], 'delete'));

    const [transition] = ledger.completedTransitions(accepted({
      'file.txt': state('file.txt', false),
    }));

    expect(transition).toMatchObject({
      before: { exists: false, text: '' },
      after: { exists: false, text: '' },
      provenance: { itemIds: ['add', 'update', 'delete'] },
    });
  });

  it('fails closed for a wrong accepted pre-image or malformed patch replay', () => {
    const wrongStart = new CodexProvenanceLedger();
    wrongStart.record(completed([update('file.txt', 'old', 'new')]));
    expect(wrongStart.completedTransitions(accepted({
      'file.txt': state('file.txt', true, 'different\n'),
    }))).toEqual([]);

    const malformed = new CodexProvenanceLedger();
    malformed.record(completed([{
      path: 'file.txt',
      kind: { type: 'update', move_path: null },
      diff: '@@ malformed @@\n-old\n+new\n',
    }]));
    expect(malformed.completedTransitions(accepted({
      'file.txt': state('file.txt', true, 'old\n'),
    }))).toEqual([]);
  });

  it('permanently rejects evidence after replay fails against its accepted pre-image', () => {
    const ledger = new CodexProvenanceLedger();
    ledger.record(completed([update('file.txt', 'old', 'new')]));

    expect(ledger.completedTransitions(accepted({
      'file.txt': state('file.txt', true, 'different\n'),
    }))).toEqual([]);

    expect(ledger.completedTransitions(accepted({
      'file.txt': state('file.txt', true, 'old\n'),
    }))).toEqual([]);
  });

  it('does not let pruning a blocking same-file record promote surviving evidence', () => {
    let now = 1_000;
    const ledger = new CodexProvenanceLedger(100, () => now);
    ledger.record(completed([update('file.txt', 'different', 'final')], 'blocker'));
    now = 1_050;
    ledger.record(completed([update('file.txt', 'old', 'new')], 'survivor'));
    const resolveAcceptedPath = accepted({ 'file.txt': state('file.txt', true, 'old\n') });

    expect(ledger.completedTransitions(resolveAcceptedPath)).toEqual([]);

    ledger.prune(1_100);
    expect(ledger.completedTransitions(resolveAcceptedPath)).toEqual([]);
  });

  it('starts a new normalized-key generation only from notifications recorded after full cleanup', () => {
    let now = 1_000;
    const ledger = new CodexProvenanceLedger(100, () => now);
    const resolveAcceptedPath = accepted({ 'file.txt': state('file.txt', true, 'old\n') });
    ledger.record(completed([update('file.txt', 'different', 'final')], 'blocker'));
    expect(ledger.completedTransitions(resolveAcceptedPath)).toEqual([]);

    now = 1_050;
    ledger.record(completed([update('file.txt', 'old', 'new')], 'before-cleanup'));
    expect(ledger.completedTransitions(resolveAcceptedPath)).toEqual([]);

    ledger.prune(1_150);
    now = 1_200;
    ledger.record(completed([update('file.txt', 'old', 'final')], 'after-cleanup'));
    expect(ledger.completedTransitions(resolveAcceptedPath)[0]).toMatchObject({
      after: { exists: true, text: 'final\n' },
      provenance: { itemIds: ['after-cleanup'] },
    });
  });

  it('rejects a pre-cleanup alias that resolves only after a newer transition is consumed', () => {
    let now = 1_000;
    let acceptedText = 'old\n';
    let aliasResolves = false;
    const ledger = new CodexProvenanceLedger(100, () => now);
    const resolveAcceptedPath = (path: string): ProvenanceFileState | undefined => {
      if (path === 'alias/file.txt' && !aliasResolves) return undefined;
      return { uri: fakeUri('file.txt'), exists: true, text: acceptedText };
    };

    ledger.record(completed([update('file.txt', 'different', 'final')], 'blocker'));
    expect(ledger.completedTransitions(resolveAcceptedPath)).toEqual([]);

    now = 1_050;
    ledger.record(completed([update('alias/file.txt', 'new', 'final')], 'stale-alias'));
    ledger.prune(1_100);

    now = 1_101;
    ledger.record(completed([update('file.txt', 'old', 'new')], 'fresh'));
    const [fresh] = ledger.completedTransitions(resolveAcceptedPath);
    expect(fresh.provenance.itemIds).toEqual(['fresh']);
    expect(ledger.consume(fresh.key, NEW_HASH)).toBe(fresh);

    acceptedText = 'new\n';
    aliasResolves = true;
    expect(ledger.completedTransitions(resolveAcceptedPath)).toEqual([]);
  });

  it('does not advance a completed cleanup watermark when an unrelated item later expires', () => {
    let now = 1_000;
    const ledger = new CodexProvenanceLedger(100, () => now);
    const resolveAcceptedPath = (path: string): ProvenanceFileState | undefined => (
      path === 'unresolved.txt' ? undefined : state('file.txt', true, 'old\n')
    );
    ledger.record(completed([update('file.txt', 'different', 'final')], 'blocker'));
    expect(ledger.completedTransitions(resolveAcceptedPath)).toEqual([]);

    now = 1_050;
    ledger.record(completed([update('unresolved.txt', 'old', 'other')], 'unrelated'));
    ledger.prune(1_100);

    now = 1_101;
    ledger.record(completed([update('file.txt', 'old', 'new')], 'fresh'));
    expect(ledger.completedTransitions(resolveAcceptedPath)[0].provenance.itemIds).toEqual(['fresh']);

    ledger.prune(1_150);
    expect(ledger.completedTransitions(resolveAcceptedPath)[0].provenance.itemIds).toEqual(['fresh']);
  });

  it('combines raw-path aliases by normalized URI and rejects their conflicting chain', () => {
    const ledger = new CodexProvenanceLedger();
    ledger.record(completed([update('SRC/file.txt', 'old', 'new')], 'first'));
    ledger.record(completed([update('src/file.txt', 'old', 'final')], 'second'));
    const normalizedState = state('src/file.txt', true, 'old\n');

    expect(ledger.completedTransitions(accepted({
      'SRC/file.txt': normalizedState,
      'src/file.txt': normalizedState,
    }))).toEqual([]);
  });

  it('rejects lifecycle mismatches and delete patches that do not replay to empty text', () => {
    const cases: readonly [CodexFileUpdateChange, ProvenanceFileState][] = [
      [add('file.txt', 'new'), state('file.txt', true, 'old\n')],
      [update('file.txt', 'old', 'new'), state('file.txt', false)],
      [remove('file.txt', 'old'), state('file.txt', false)],
      [{
        path: 'file.txt',
        kind: { type: 'delete' },
        diff: update('file.txt', 'old', 'new').diff,
      }, state('file.txt', true, 'old\n')],
    ];

    for (const [change, acceptedState] of cases) {
      const ledger = new CodexProvenanceLedger();
      ledger.record(completed([change]));
      expect(ledger.completedTransitions(accepted({ 'file.txt': acceptedState }))).toEqual([]);
    }
  });

  it('does not produce transitions for move paths', () => {
    const ledger = new CodexProvenanceLedger();
    ledger.record(completed([{
      ...update('source.txt', 'old', 'new'),
      kind: { type: 'update', move_path: 'destination.txt' },
    }]));

    expect(ledger.completedTransitions(accepted({
      'source.txt': state('source.txt', true, 'old\n'),
      'destination.txt': state('destination.txt', false),
    }))).toEqual([]);
  });

  it('consumes only a matching post-image hash and supports explicit invalidation', () => {
    const ledger = new CodexProvenanceLedger();
    ledger.record(completed([update('file.txt', 'old', 'new')]));
    const resolveAcceptedPath = accepted({ 'file.txt': state('file.txt', true, 'old\n') });
    ledger.completedTransitions(resolveAcceptedPath);

    expect(ledger.consume('file:///workspace/file.txt', FINAL_HASH)).toBeUndefined();
    expect(ledger.completedTransitions(resolveAcceptedPath)).toHaveLength(1);

    ledger.invalidate('file:///workspace/file.txt');
    expect(ledger.consume('file:///workspace/file.txt', NEW_HASH)).toBeUndefined();
    expect(ledger.completedTransitions(resolveAcceptedPath)).toEqual([]);
  });

  it('retires one normalized key without clearing unrelated ready evidence', () => {
    const ledger = new CodexProvenanceLedger();
    ledger.record(completed([update('a.txt', 'old-a', 'new')], 'item-a'));
    ledger.record(completed([update('b.txt', 'old-b', 'new')], 'item-b'));
    const resolveAcceptedPath = accepted({
      'a.txt': state('a.txt', true, 'old-a\n'),
      'b.txt': state('b.txt', true, 'old-b\n'),
    });
    ledger.completedTransitions(resolveAcceptedPath);

    ledger.retireKey(
      'file:///workspace/a.txt',
      ['thread-1\0turn-1\0item-a'],
    );

    expect(ledger.consume('file:///workspace/a.txt', NEW_HASH)).toBeUndefined();
    expect(ledger.consume('file:///workspace/b.txt', NEW_HASH)).toEqual(
      expect.objectContaining({ key: 'file:///workspace/b.txt' }),
    );
  });

  it('retires only one file from a shared multi-file item', () => {
    const ledger = new CodexProvenanceLedger();
    ledger.record(completed([
      update('a.txt', 'old-a', 'new'),
      update('b.txt', 'old-b', 'new'),
    ], 'shared-item'));
    const resolveAcceptedPath = accepted({
      'a.txt': state('a.txt', true, 'old-a\n'),
      'b.txt': state('b.txt', true, 'old-b\n'),
    });
    ledger.completedTransitions(resolveAcceptedPath);

    ledger.retireKey(
      'file:///workspace/a.txt',
      ['thread-1\0turn-1\0shared-item'],
    );

    expect(ledger.consume('file:///workspace/a.txt', NEW_HASH)).toBeUndefined();
    expect(ledger.consume('file:///workspace/b.txt', NEW_HASH)).toEqual(
      expect.objectContaining({
        key: 'file:///workspace/b.txt',
        provenance: expect.objectContaining({ itemIds: ['shared-item'] }),
      }),
    );
  });

  it('clears ready, retired, and generation evidence for a workspace reset', () => {
    const ledger = new CodexProvenanceLedger();
    const resolveAcceptedPath = accepted({
      'file.txt': state('file.txt', true, 'old\n'),
    });
    const notification = completed([update('file.txt', 'old', 'new')]);
    ledger.record(notification);
    ledger.completedTransitions(resolveAcceptedPath);
    ledger.invalidate('file:///workspace/file.txt');

    const clear = (ledger as CodexProvenanceLedger & { clear(): void }).clear;
    expect(clear).toBeTypeOf('function');
    if (clear === undefined) return;
    clear.call(ledger);

    expect(ledger.completedTransitions(resolveAcceptedPath)).toEqual([]);
    ledger.record(notification);
    expect(ledger.completedTransitions(resolveAcceptedPath)).toHaveLength(1);
  });

  it('prunes expired entries without turning elapsed time into proof', () => {
    let now = 1_000;
    const ledger = new CodexProvenanceLedger(100, () => now);
    ledger.record(completed([update('file.txt', 'old', 'new')]));
    const resolveAcceptedPath = accepted({ 'file.txt': state('file.txt', true, 'old\n') });

    ledger.prune(1_099);
    expect(ledger.completedTransitions(resolveAcceptedPath)).toHaveLength(1);

    now = 1_100;
    ledger.prune(now);
    expect(ledger.completedTransitions(resolveAcceptedPath)).toEqual([]);
  });
});
