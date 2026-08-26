import type * as vscode from 'vscode';
import type {
  CodexFileChangeStatus,
  CodexFileUpdateChange,
  CodexProvenanceNotification,
} from './codexProvenanceProtocol';
import { applyUnifiedFilePatch, sha256Text } from './unifiedFilePatch';

export interface ProvenanceFileState {
  readonly uri: vscode.Uri;
  readonly exists: boolean;
  readonly text: string;
}

export interface ExactCodexTransition {
  readonly key: string;
  readonly uri: vscode.Uri;
  readonly before: ProvenanceFileState;
  readonly after: ProvenanceFileState;
  readonly provenance: {
    readonly confidence: 'exact';
    readonly threadId: string;
    readonly turnId: string;
    readonly itemIds: readonly string[];
  };
}

export type AcceptedStateResolver = (
  path: string,
) => ProvenanceFileState | undefined;

interface ItemRecord {
  readonly key: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  changes: readonly CodexFileUpdateChange[];
  terminalStatus: CodexFileChangeStatus | undefined;
  invalid: boolean;
  updatedAt: number;
}

interface ReadyTransition {
  readonly transition: ExactCodexTransition;
  readonly afterHash: string;
  readonly evidence: readonly string[];
}

const DEFAULT_RETENTION_MS = 5 * 60 * 1_000;

function itemKey(threadId: string, turnId: string, itemId: string): string {
  return `${threadId}\0${turnId}\0${itemId}`;
}

function evidenceKey(item: ItemRecord, path: string): string {
  return `${item.key}\0${path}`;
}

function sameChanges(
  left: readonly CodexFileUpdateChange[],
  right: readonly CodexFileUpdateChange[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((change, index) => {
    const other = right[index];
    if (change.path !== other.path || change.diff !== other.diff || change.kind.type !== other.kind.type) {
      return false;
    }
    return change.kind.type !== 'update'
      || (other.kind.type === 'update' && change.kind.move_path === other.kind.move_path);
  });
}

function nextState(
  current: ProvenanceFileState,
  change: CodexFileUpdateChange,
): ProvenanceFileState | undefined {
  if (change.kind.type === 'update' && change.kind.move_path !== null) return undefined;
  if (!current.exists && current.text !== '') return undefined;

  if (change.kind.type === 'add') {
    if (current.exists) return undefined;
    const text = applyUnifiedFilePatch('', change.diff);
    return text === undefined ? undefined : { uri: current.uri, exists: true, text };
  }

  if (!current.exists) return undefined;
  const text = applyUnifiedFilePatch(current.text, change.diff);
  if (text === undefined) return undefined;

  if (change.kind.type === 'delete') {
    return text === '' ? { uri: current.uri, exists: false, text: '' } : undefined;
  }

  return { uri: current.uri, exists: true, text };
}

export class CodexProvenanceLedger {
  private readonly items = new Map<string, ItemRecord>();
  private readonly consumedEvidence = new Set<string>();
  private readonly ready = new Map<string, ReadyTransition>();

  constructor(
    private readonly retentionMs = DEFAULT_RETENTION_MS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(retentionMs) || retentionMs < 0) {
      throw new RangeError('retentionMs must be a non-negative finite number');
    }
  }

  record(notification: CodexProvenanceNotification): void {
    const threadId = notification.params.threadId;
    const turnId = notification.params.turnId;
    const itemId = notification.method === 'item/completed'
      ? notification.params.item.id
      : notification.params.itemId;
    const key = itemKey(threadId, turnId, itemId);
    const changes = notification.method === 'item/completed'
      ? notification.params.item.changes
      : notification.params.changes;
    const existing = this.items.get(key);

    if (existing === undefined) {
      this.items.set(key, {
        key,
        threadId,
        turnId,
        itemId,
        changes,
        terminalStatus: notification.method === 'item/completed'
          ? notification.params.item.status
          : undefined,
        invalid: false,
        updatedAt: this.now(),
      });
      this.ready.clear();
      return;
    }

    if (existing.invalid) return;

    if (notification.method === 'item/fileChange/patchUpdated') {
      if (existing.terminalStatus !== undefined) {
        if (!sameChanges(existing.changes, changes)) {
          existing.invalid = true;
          this.ready.clear();
        }
        return;
      }
      if (!sameChanges(existing.changes, changes)) {
        existing.changes = changes;
        existing.updatedAt = this.now();
        this.ready.clear();
      }
      return;
    }

    if (existing.terminalStatus !== undefined) {
      if (existing.terminalStatus !== notification.params.item.status
        || !sameChanges(existing.changes, changes)) {
        existing.invalid = true;
        this.ready.clear();
      }
      return;
    }

    existing.changes = changes;
    existing.terminalStatus = notification.params.item.status;
    existing.updatedAt = this.now();
    this.ready.clear();
  }

  completedTransitions(
    resolveAcceptedPath: AcceptedStateResolver,
  ): readonly ExactCodexTransition[] {
    this.ready.clear();
    const changesByPath = new Map<string, { item: ItemRecord; change: CodexFileUpdateChange }[]>();

    for (const item of this.items.values()) {
      if (item.invalid || item.terminalStatus !== 'completed') continue;
      for (const change of item.changes) {
        if (this.consumedEvidence.has(evidenceKey(item, change.path))) continue;
        const changes = changesByPath.get(change.path) ?? [];
        changes.push({ item, change });
        changesByPath.set(change.path, changes);
      }
    }

    for (const [path, links] of changesByPath) {
      const accepted = resolveAcceptedPath(path);
      if (accepted === undefined || (!accepted.exists && accepted.text !== '')) continue;

      const first = links[0].item;
      if (links.some(({ item }) => item.threadId !== first.threadId || item.turnId !== first.turnId)) {
        continue;
      }

      const before = { uri: accepted.uri, exists: accepted.exists, text: accepted.text };
      let current: ProvenanceFileState = before;
      let precedingAfterHash = sha256Text(current.text);
      const itemIds: string[] = [];
      const evidence: string[] = [];
      let valid = true;

      for (const { item, change } of links) {
        const beforeHash = sha256Text(current.text);
        if (beforeHash !== precedingAfterHash) {
          valid = false;
          break;
        }
        const after = nextState(current, change);
        if (after === undefined) {
          valid = false;
          break;
        }
        current = after;
        precedingAfterHash = sha256Text(after.text);
        if (itemIds[itemIds.length - 1] !== item.itemId) itemIds.push(item.itemId);
        evidence.push(evidenceKey(item, path));
      }

      if (!valid) continue;
      const key = accepted.uri.toString();
      const transition: ExactCodexTransition = {
        key,
        uri: accepted.uri,
        before,
        after: current,
        provenance: {
          confidence: 'exact',
          threadId: first.threadId,
          turnId: first.turnId,
          itemIds,
        },
      };
      this.ready.set(key, { transition, afterHash: precedingAfterHash, evidence });
    }

    return [...this.ready.values()].map(({ transition }) => transition);
  }

  consume(key: string, afterHash: string): ExactCodexTransition | undefined {
    const ready = this.ready.get(key);
    if (ready === undefined || ready.afterHash !== afterHash) return undefined;
    for (const evidence of ready.evidence) this.consumedEvidence.add(evidence);
    this.ready.delete(key);
    return ready.transition;
  }

  invalidate(key: string): void {
    const ready = this.ready.get(key);
    if (ready === undefined) return;
    for (const evidence of ready.evidence) this.consumedEvidence.add(evidence);
    this.ready.delete(key);
  }

  prune(now: number): void {
    let changed = false;
    for (const [key, item] of this.items) {
      if (item.updatedAt + this.retentionMs <= now) {
        this.items.delete(key);
        changed = true;
      }
    }
    if (changed) this.ready.clear();
  }
}
