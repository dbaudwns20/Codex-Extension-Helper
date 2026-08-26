import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  CodexChangeGate,
  type CodexChangeGateOptions,
  type FileSystemCandidate,
} from '../../src/codexChangeGate';
import {
  CodexProvenanceLedger,
  type ProvenanceFileState,
} from '../../src/codexProvenanceLedger';
import type { CodexFileUpdateChange } from '../../src/codexProvenanceProtocol';

function fakeUri(path: string): vscode.Uri {
  return { toString: () => `file:///workspace/${path}` } as vscode.Uri;
}

function state(path: string, exists: boolean, text = ''): ProvenanceFileState {
  return { uri: fakeUri(path), exists, text };
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

function patchUpdated(changes: readonly CodexFileUpdateChange[]) {
  return {
    method: 'item/fileChange/patchUpdated',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', changes },
  };
}

function completed(changes: readonly CodexFileUpdateChange[], itemId = 'item-1') {
  return {
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: itemId, type: 'fileChange', status: 'completed', changes },
    },
  };
}

class FakeClock {
  private value = 1_000;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  readonly now = () => this.value;

  readonly setTimer = (callback: () => void, delayMs: number): number => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.value + delayMs, callback });
    return id;
  };

  readonly clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    this.value += ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.value)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (due === undefined) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }

  elapseWithoutTimers(ms: number): void {
    this.value += ms;
  }
}

function present(path: string, text: string): FileSystemCandidate {
  const uri = fakeUri(path);
  return { kind: 'present', key: uri.toString(), uri, text };
}

function absent(path: string): FileSystemCandidate {
  const uri = fakeUri(path);
  return { kind: 'absent', key: uri.toString(), uri };
}

function setup(
  acceptedStates: Record<string, ProvenanceFileState>,
  overrides: Partial<CodexChangeGateOptions> = {},
) {
  const clock = new FakeClock();
  const proven: unknown[] = [];
  const unproven: FileSystemCandidate[] = [];
  const options: CodexChangeGateOptions = {
    resolveAcceptedPath: (path) => acceptedStates[path],
    resolveWorkspacePath: (path) => acceptedStates[path]?.uri,
    callbacks: {
      onProven: async (transition) => { proven.push(transition); },
      onUnproven: async (candidate) => { unproven.push(candidate); },
    },
    quarantineMs: 100,
    transitionLifetimeMs: 200,
    maxPendingCandidates: 8,
    maxEligibleTransitions: 8,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  };
  const gate = new CodexChangeGate(options);
  const flush = () => gate.handleNotification(null);
  return { clock, gate, options, proven, unproven, flush };
}

describe('CodexChangeGate', () => {
  it.each(['notification-first', 'candidate-first'] as const)(
    'fails closed for workspace/accepted key disagreement in %s order',
    async (order) => {
      const workspaceCandidate = present('workspace-a.txt', 'new\n');
      const acceptedCandidate = present('accepted-b.txt', 'new\n');
      const acceptedState: ProvenanceFileState = {
        uri: acceptedCandidate.uri,
        exists: true,
        text: 'old\n',
      };
      let workspaceUri: vscode.Uri | undefined = workspaceCandidate.uri;
      const { clock, gate, proven, unproven, flush } = setup({
        'file.txt': acceptedState,
      }, {
        resolveWorkspacePath: () => workspaceUri,
      });
      const notification = completed([update('file.txt', 'old', 'new')]);

      if (order === 'candidate-first') {
        await gate.handleCandidate(workspaceCandidate);
        await gate.handleCandidate(acceptedCandidate);
      }
      await gate.handleNotification(notification);
      if (order === 'notification-first') {
        await gate.handleCandidate(workspaceCandidate);
        await gate.handleCandidate(acceptedCandidate);
      }

      expect(proven).toEqual([]);
      if (order === 'candidate-first') {
        expect(unproven).toEqual([workspaceCandidate, acceptedCandidate]);
      } else {
        expect(unproven).toEqual([]);
      }

      workspaceUri = acceptedState.uri;
      const laterCandidate = order === 'candidate-first'
        ? present('accepted-b.txt', 'new\n')
        : acceptedCandidate;
      if (order === 'candidate-first') await gate.handleCandidate(laterCandidate);
      await gate.handleNotification(notification);
      clock.advance(100);
      await flush();

      expect(proven).toEqual([]);
      for (const candidate of [workspaceCandidate, acceptedCandidate, laterCandidate]) {
        expect(unproven.filter((value) => value === candidate)).toHaveLength(1);
      }
    },
  );

  it.each(['notification-first', 'candidate-first'] as const)(
    'fails closed when workspace resolution is absent in %s order',
    async (order) => {
      const acceptedCandidate = present('accepted-b.txt', 'new\n');
      const acceptedState: ProvenanceFileState = {
        uri: acceptedCandidate.uri,
        exists: true,
        text: 'old\n',
      };
      let workspaceUri: vscode.Uri | undefined;
      const { gate, proven, unproven } = setup({
        'file.txt': acceptedState,
      }, {
        resolveWorkspacePath: () => workspaceUri,
      });
      const notification = completed([update('file.txt', 'old', 'new')]);

      if (order === 'candidate-first') await gate.handleCandidate(acceptedCandidate);
      await gate.handleNotification(notification);
      if (order === 'notification-first') await gate.handleCandidate(acceptedCandidate);

      expect(proven).toEqual([]);
      expect(unproven).toEqual(order === 'candidate-first' ? [acceptedCandidate] : []);

      workspaceUri = acceptedState.uri;
      const laterCandidate = order === 'candidate-first'
        ? present('accepted-b.txt', 'new\n')
        : acceptedCandidate;
      if (order === 'candidate-first') await gate.handleCandidate(laterCandidate);
      await gate.handleNotification(notification);

      expect(proven).toEqual([]);
      expect(unproven.filter((value) => value === acceptedCandidate)).toHaveLength(1);
      expect(unproven.filter((value) => value === laterCandidate)).toHaveLength(1);
    },
  );

  it.each(['notification-first', 'candidate-first'] as const)(
    'rejects and never reuses accepted-undefined evidence in %s order',
    async (order) => {
      const initialCandidate = present('workspace-a.txt', 'new\n');
      const acceptedState: ProvenanceFileState = {
        uri: initialCandidate.uri,
        exists: true,
        text: 'old\n',
      };
      let currentAccepted: ProvenanceFileState | undefined;
      const { gate, proven, unproven } = setup({}, {
        resolveAcceptedPath: () => currentAccepted,
        resolveWorkspacePath: () => initialCandidate.uri,
      });
      const notification = completed([update('file.txt', 'old', 'new')]);

      if (order === 'candidate-first') await gate.handleCandidate(initialCandidate);
      await gate.handleNotification(notification);
      if (order === 'notification-first') await gate.handleCandidate(initialCandidate);

      expect(proven).toEqual([]);
      expect(unproven).toEqual(order === 'candidate-first' ? [initialCandidate] : []);

      currentAccepted = acceptedState;
      const laterCandidate = order === 'candidate-first'
        ? present('workspace-a.txt', 'new\n')
        : initialCandidate;
      if (order === 'candidate-first') await gate.handleCandidate(laterCandidate);
      await gate.handleNotification(notification);

      expect(proven).toEqual([]);
      expect(unproven.filter((value) => value === initialCandidate)).toHaveLength(1);
      expect(unproven.filter((value) => value === laterCandidate)).toHaveLength(1);
    },
  );

  it.each(['notification-first', 'candidate-first'] as const)(
    'rejects and never reuses both-undefined evidence in %s order',
    async (order) => {
      const candidate = present('workspace-a.txt', 'new\n');
      const acceptedState: ProvenanceFileState = {
        uri: candidate.uri,
        exists: true,
        text: 'old\n',
      };
      let resolutionAvailable = false;
      const { clock, gate, proven, unproven, flush } = setup({}, {
        resolveAcceptedPath: () => resolutionAvailable ? acceptedState : undefined,
        resolveWorkspacePath: () => resolutionAvailable ? candidate.uri : undefined,
      });
      const notification = completed([update('file.txt', 'old', 'new')]);

      if (order === 'candidate-first') await gate.handleCandidate(candidate);
      await gate.handleNotification(notification);
      if (order === 'notification-first') await gate.handleCandidate(candidate);

      expect(proven).toEqual([]);
      expect(unproven).toEqual([]);

      resolutionAvailable = true;
      await gate.handleNotification(notification);
      clock.advance(100);
      await flush();

      expect(proven).toEqual([]);
      expect(unproven).toEqual([candidate]);
    },
  );

  it('retires previously valid evidence before accepted-undefined refresh can clear its index', async () => {
    const candidate = present('workspace-a.txt', 'new\n');
    const acceptedState: ProvenanceFileState = {
      uri: candidate.uri,
      exists: true,
      text: 'old\n',
    };
    let currentAccepted: ProvenanceFileState | undefined = acceptedState;
    const { clock, gate, proven, unproven, flush } = setup({}, {
      resolveAcceptedPath: () => currentAccepted,
      resolveWorkspacePath: () => candidate.uri,
    });
    const notification = completed([update('file.txt', 'old', 'new')]);

    await gate.handleNotification(notification);
    currentAccepted = undefined;
    await gate.handleNotification(notification);
    currentAccepted = acceptedState;
    await gate.handleNotification(notification);
    await gate.handleCandidate(candidate);
    clock.advance(100);
    await flush();

    expect(proven).toEqual([]);
    expect(unproven).toEqual([candidate]);
  });

  it('does not reconstruct a rejected item after ledger indexes were already cleared', async () => {
    const candidate = present('workspace-a.txt', 'new\n');
    const acceptedState: ProvenanceFileState = {
      uri: candidate.uri,
      exists: true,
      text: 'old\n',
    };
    const otherState = state('other.txt', true, 'old-other\n');
    let acceptedAvailable = true;
    const ledger = new CodexProvenanceLedger();
    const { clock, gate, proven, unproven, flush } = setup({}, {
      ledger,
      resolveAcceptedPath: (path) => (
        path === 'file.txt'
          ? (acceptedAvailable ? acceptedState : undefined)
          : otherState
      ),
      resolveWorkspacePath: (path) => (
        path === 'file.txt' ? candidate.uri : otherState.uri
      ),
    });
    const rejectedNotification = completed([
      update('file.txt', 'old', 'new'),
    ], 'rejected-item');

    await gate.handleNotification(rejectedNotification);
    ledger.completedTransitions(() => undefined);
    acceptedAvailable = false;
    await gate.handleNotification(rejectedNotification);
    acceptedAvailable = true;
    await gate.handleNotification(completed([
      update('other.txt', 'old-other', 'new-other'),
    ], 'unrelated-item'));
    await gate.handleCandidate(candidate);
    clock.advance(100);
    await flush();

    expect(proven).toEqual([]);
    expect(unproven).toEqual([candidate]);
  });

  it('invalidates prior evidence under the workspace side of a disagreement', async () => {
    const workspaceCandidate = present('workspace-a.txt', 'new\n');
    const workspaceState: ProvenanceFileState = {
      uri: workspaceCandidate.uri,
      exists: true,
      text: 'old-a\n',
    };
    const acceptedState = state('accepted-b.txt', true, 'old\n');
    const { clock, gate, proven, unproven, flush } = setup({
      'workspace.txt': workspaceState,
      'file.txt': acceptedState,
    }, {
      resolveWorkspacePath: (path) => (
        path === 'workspace.txt' ? workspaceState.uri : workspaceCandidate.uri
      ),
    });

    await gate.handleNotification(completed([
      update('workspace.txt', 'old-a', 'new'),
    ], 'workspace-item'));
    await gate.handleNotification(completed([
      update('file.txt', 'old', 'new'),
    ], 'disagreement-item'));
    await gate.handleCandidate(workspaceCandidate);
    clock.advance(100);
    await flush();

    expect(proven).toEqual([]);
    expect(unproven).toEqual([workspaceCandidate]);
  });

  it('proves an exact post-image when completion arrives before the watcher candidate', async () => {
    const change = update('file.txt', 'old', 'new');
    const { gate, proven, unproven } = setup({
      'file.txt': state('file.txt', true, 'old\n'),
    });

    await gate.handleNotification(completed([change]));
    expect(proven).toEqual([]);

    await gate.handleCandidate(present('file.txt', 'new\n'));

    expect(proven).toEqual([expect.objectContaining({
      key: 'file:///workspace/file.txt',
      after: expect.objectContaining({ exists: true, text: 'new\n' }),
    })]);
    expect(unproven).toEqual([]);
  });

  it('quarantines a watcher-first candidate until matching completion arrives', async () => {
    const change = update('file.txt', 'old', 'new');
    const { gate, proven, unproven } = setup({
      'file.txt': state('file.txt', true, 'old\n'),
    });
    const candidate = present('file.txt', 'new\n');

    await gate.handleNotification(patchUpdated([change]));
    await gate.handleCandidate(candidate);
    expect(proven).toEqual([]);
    expect(unproven).toEqual([]);

    await gate.handleNotification(completed([change]));

    expect(proven).toHaveLength(1);
    expect(unproven).toEqual([]);
  });

  it('fails closed immediately when completed evidence has a different post-image', async () => {
    const change = update('file.txt', 'old', 'new');
    const candidate = present('file.txt', 'external\n');
    const { gate, proven, unproven } = setup({
      'file.txt': state('file.txt', true, 'old\n'),
    });

    await gate.handleCandidate(candidate);
    await gate.handleNotification(completed([change]));

    expect(proven).toEqual([]);
    expect(unproven).toEqual([candidate]);
  });

  it('expires an unmatched candidate only as unproven', async () => {
    const candidate = present('file.txt', 'external\n');
    const { clock, gate, proven, unproven, flush } = setup({
      'file.txt': state('file.txt', true, 'old\n'),
    });

    await gate.handleCandidate(candidate);
    clock.advance(100);
    await flush();

    expect(unproven).toEqual([candidate]);
    expect(proven).toEqual([]);
  });

  it('settles a duplicate watcher candidate separately and keeps only the newer candidate', async () => {
    const first = present('file.txt', 'new\n');
    const duplicate = present('file.txt', 'new\n');
    const change = update('file.txt', 'old', 'new');
    const { gate, proven, unproven } = setup({
      'file.txt': state('file.txt', true, 'old\n'),
    });

    await gate.handleCandidate(first);
    await gate.handleCandidate(duplicate);
    expect(unproven).toEqual([first]);

    await gate.handleNotification(completed([change]));

    expect(proven).toHaveLength(1);
    expect(unproven).toEqual([first]);
  });

  it('unproves an older candidate exactly once when a newer post-image supersedes it', async () => {
    const older = present('file.txt', 'intermediate\n');
    const newer = present('file.txt', 'new\n');
    const { gate, proven, unproven } = setup({
      'file.txt': state('file.txt', true, 'old\n'),
    });

    await gate.handleCandidate(older);
    await gate.handleCandidate(newer);
    await gate.handleNotification(completed([update('file.txt', 'old', 'new')]));

    expect(unproven).toEqual([older]);
    expect(proven).toHaveLength(1);
  });

  it('proves deletion only from exact completed absence evidence', async () => {
    const { gate, proven, unproven } = setup({
      'file.txt': state('file.txt', true, 'old\n'),
    });

    await gate.handleNotification(completed([remove('file.txt', 'old')]));
    await gate.handleCandidate(absent('file.txt'));

    expect(proven).toEqual([expect.objectContaining({
      before: expect.objectContaining({ exists: true, text: 'old\n' }),
      after: expect.objectContaining({ exists: false, text: '' }),
    })]);
    expect(unproven).toEqual([]);
  });

  it('fails closed when deletion evidence encounters a present empty file', async () => {
    const candidate = present('file.txt', '');
    const { gate, proven, unproven } = setup({
      'file.txt': state('file.txt', true, 'old\n'),
    });

    await gate.handleNotification(completed([remove('file.txt', 'old')]));
    await gate.handleCandidate(candidate);

    expect(proven).toEqual([]);
    expect(unproven).toEqual([candidate]);
  });

  it('fails closed when completed evidence cannot replay against accepted state', async () => {
    const candidate = present('file.txt', 'new\n');
    const invalidChange: CodexFileUpdateChange = {
      path: 'file.txt',
      kind: { type: 'update', move_path: null },
      diff: '@@ malformed @@\n-old\n+new\n',
    };
    const { gate, proven, unproven } = setup({
      'file.txt': state('file.txt', true, 'old\n'),
    });

    await gate.handleCandidate(candidate);
    await gate.handleNotification(completed([invalidChange]));

    expect(proven).toEqual([]);
    expect(unproven).toEqual([candidate]);
  });

  it('ignores malformed notifications without resolving paths or changing pending state', async () => {
    const candidate = present('file.txt', 'new\n');
    const resolvedPaths: string[] = [];
    const acceptedState = state('file.txt', true, 'old\n');
    const { gate, proven, unproven } = setup({ 'file.txt': acceptedState }, {
      resolveAcceptedPath: (path) => {
        resolvedPaths.push(path);
        return acceptedState;
      },
      resolveWorkspacePath: (path) => {
        resolvedPaths.push(path);
        return acceptedState.uri;
      },
    });

    await gate.handleCandidate(candidate);
    await gate.handleNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'item-1',
          type: 'fileChange',
          status: 'completed',
          changes: [{ ...update('file.txt', 'old', 'new'), path: '../escape.txt' }],
        },
      },
    });

    expect(resolvedPaths).toEqual([]);
    expect(proven).toEqual([]);
    expect(unproven).toEqual([]);

    await gate.handleNotification(completed([update('file.txt', 'old', 'new')]));
    expect(proven).toHaveLength(1);
  });

  it('unproves every pending candidate once on disposal and cancels later expiry', async () => {
    const first = present('a.txt', 'external-a\n');
    const second = present('b.txt', 'external-b\n');
    const { clock, gate, proven, unproven, flush } = setup({
      'a.txt': state('a.txt', true, 'old-a\n'),
      'b.txt': state('b.txt', true, 'old-b\n'),
    });

    await gate.handleCandidate(first);
    await gate.handleCandidate(second);
    gate.dispose();
    await flush();
    clock.advance(1_000);
    await flush();

    expect(unproven).toEqual([first, second]);
    expect(proven).toEqual([]);
  });

  it('bounds pending candidates by count and unproves the oldest on eviction', async () => {
    const first = present('a.txt', 'external-a\n');
    const second = present('b.txt', 'external-b\n');
    const { gate, unproven } = setup({
      'a.txt': state('a.txt', true, 'old-a\n'),
      'b.txt': state('b.txt', true, 'old-b\n'),
    }, { maxPendingCandidates: 1 });

    await gate.handleCandidate(first);
    await gate.handleCandidate(second);

    expect(unproven).toEqual([first]);
  });

  it('bounds eligible transitions by count and never promotes evicted evidence', async () => {
    const first = present('a.txt', 'new-a\n');
    const second = present('b.txt', 'new-b\n');
    const { clock, gate, proven, unproven, flush } = setup({
      'a.txt': state('a.txt', true, 'old-a\n'),
      'b.txt': state('b.txt', true, 'old-b\n'),
    }, { maxEligibleTransitions: 1 });

    await gate.handleNotification(completed([update('a.txt', 'old-a', 'new-a')], 'item-a'));
    await gate.handleNotification(completed([update('b.txt', 'old-b', 'new-b')], 'item-b'));
    await gate.handleCandidate(second);
    await gate.handleCandidate(first);
    clock.advance(100);
    await flush();

    expect(proven).toEqual([expect.objectContaining({ key: second.key })]);
    expect(unproven).toEqual([first]);
  });

  it('expires eligible transitions without proving a later candidate by timing', async () => {
    const change = update('file.txt', 'old', 'new');
    const candidate = present('file.txt', 'new\n');
    const { clock, gate, proven, unproven, flush } = setup({
      'file.txt': state('file.txt', true, 'old\n'),
    });

    await gate.handleNotification(completed([change]));
    clock.advance(200);
    await flush();
    await gate.handleCandidate(candidate);
    clock.advance(100);
    await flush();

    expect(proven).toEqual([]);
    expect(unproven).toEqual([candidate]);
  });

  it('serializes replacement callbacks so races cannot settle either candidate twice', async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstSettled = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const older = present('file.txt', 'external\n');
    const newer = present('file.txt', 'new\n');
    const calls: string[] = [];
    const acceptedState = state('file.txt', true, 'old\n');
    const { gate } = setup({ 'file.txt': acceptedState }, {
      callbacks: {
        onUnproven: async (candidate) => {
          calls.push(`unproven:${candidate.kind === 'present' ? candidate.text.trim() : 'absent'}`);
          if (candidate === older) {
            markFirstStarted();
            await firstSettled;
          }
        },
        onProven: async () => { calls.push('proven'); },
      },
    });

    await gate.handleCandidate(older);
    const replacement = gate.handleCandidate(newer);
    const notification = gate.handleNotification(completed([update('file.txt', 'old', 'new')]));
    await firstStarted;
    expect(calls).toEqual(['unproven:external']);

    releaseFirst();
    await replacement;
    await notification;

    expect(calls).toEqual(['unproven:external', 'proven']);
  });

  it('keeps the newer candidate live when the superseded callback rejects', async () => {
    const older = present('file.txt', 'external\n');
    const newer = present('file.txt', 'new\n');
    const proven: unknown[] = [];
    const acceptedState = state('file.txt', true, 'old\n');
    const { gate } = setup({ 'file.txt': acceptedState }, {
      callbacks: {
        onUnproven: async (candidate) => {
          if (candidate === older) throw new Error('baseline failed');
        },
        onProven: async (transition) => { proven.push(transition); },
      },
    });

    await gate.handleCandidate(older);
    await expect(gate.handleCandidate(newer)).rejects.toThrow('baseline failed');
    await gate.handleNotification(completed([update('file.txt', 'old', 'new')]));

    expect(proven).toHaveLength(1);
  });

  it('attempts every disposal settlement even when one callback rejects', async () => {
    const first = present('a.txt', 'external-a\n');
    const second = present('b.txt', 'external-b\n');
    const settled: FileSystemCandidate[] = [];
    const { gate, flush } = setup({
      'a.txt': state('a.txt', true, 'old-a\n'),
      'b.txt': state('b.txt', true, 'old-b\n'),
    }, {
      callbacks: {
        onUnproven: async (candidate) => {
          settled.push(candidate);
          if (candidate === first) throw new Error('baseline failed');
        },
        onProven: async () => undefined,
      },
    });

    await gate.handleCandidate(first);
    await gate.handleCandidate(second);
    gate.dispose();
    await flush();

    expect(settled).toEqual([first, second]);
  });

  it('settles every relevant candidate when one terminal callback rejects', async () => {
    const first = present('a.txt', 'external-a\n');
    const second = present('b.txt', 'external-b\n');
    const settled: FileSystemCandidate[] = [];
    const { gate } = setup({
      'a.txt': state('a.txt', true, 'old-a\n'),
      'b.txt': state('b.txt', true, 'old-b\n'),
    }, {
      callbacks: {
        onUnproven: async (candidate) => {
          settled.push(candidate);
          if (candidate === first) throw new Error('baseline failed');
        },
        onProven: async () => undefined,
      },
    });

    await gate.handleCandidate(first);
    await gate.handleCandidate(second);
    await expect(gate.handleNotification(completed([
      update('a.txt', 'old-a', 'codex-a'),
      update('b.txt', 'old-b', 'codex-b'),
    ]))).rejects.toThrow('baseline failed');

    expect(settled).toEqual([first, second]);
  });

  it('settles every expired candidate when one timeout callback rejects', async () => {
    const first = present('a.txt', 'external-a\n');
    const second = present('b.txt', 'external-b\n');
    const settled: FileSystemCandidate[] = [];
    const { clock, gate, flush } = setup({
      'a.txt': state('a.txt', true, 'old-a\n'),
      'b.txt': state('b.txt', true, 'old-b\n'),
    }, {
      callbacks: {
        onUnproven: async (candidate) => {
          settled.push(candidate);
          if (candidate === first) throw new Error('baseline failed');
        },
        onProven: async () => undefined,
      },
    });

    await gate.handleCandidate(first);
    await gate.handleCandidate(second);
    clock.advance(100);
    await flush();

    expect(settled).toEqual([first, second]);
  });

  it('keeps an incoming candidate live when an overdue callback rejects', async () => {
    const overdue = present('old.txt', 'external\n');
    const incoming = present('file.txt', 'new\n');
    const proven: unknown[] = [];
    const { clock, gate } = setup({
      'old.txt': state('old.txt', true, 'old\n'),
      'file.txt': state('file.txt', true, 'old\n'),
    }, {
      callbacks: {
        onUnproven: async (candidate) => {
          if (candidate === overdue) throw new Error('baseline failed');
        },
        onProven: async (transition) => { proven.push(transition); },
      },
    });

    await gate.handleCandidate(overdue);
    clock.elapseWithoutTimers(100);
    await expect(gate.handleCandidate(incoming)).rejects.toThrow('baseline failed');
    await gate.handleNotification(completed([update('file.txt', 'old', 'new')]));

    expect(proven).toHaveLength(1);
  });
});
