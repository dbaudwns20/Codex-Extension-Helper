import type * as vscode from 'vscode';
import { createHash } from 'node:crypto';
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
  readonly order: number;
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

interface NormalizedEvidenceGroup {
  readonly accepted: ProvenanceFileState;
  readonly links: { item: ItemRecord; change: CodexFileUpdateChange }[];
  readonly evidence: Set<string>;
  readonly itemKeys: Set<string>;
  acceptedStateConflict: boolean;
}

interface InvalidatedGeneration {
  readonly evidence: Set<string>;
  readonly itemKeys: Set<string>;
  cleanupWatermark: number;
  cleanupComplete: boolean;
  expiresAt: number;
  order: number;
}

interface EvidenceTombstone {
  readonly expiresAt: number;
  readonly order: number;
}

export interface CodexProvenanceLedgerTombstoneOptions {
  readonly maxEvidenceTombstones?: number;
  readonly tombstoneLifetimeMs?: number;
}

const DEFAULT_RETENTION_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_EVIDENCE_TOMBSTONES = 4_096;
const DEFAULT_TOMBSTONE_LIFETIME_MS = 5 * 60 * 1_000;
const ARCHIVED_TOMBSTONE_BITS = 65_536;

class ArchivedTombstoneFilter {
  private readonly bytes = new Uint8Array(ARCHIVED_TOMBSTONE_BITS / 8);

  add(value: string): void {
    for (const bit of this.bits(value)) {
      this.bytes[Math.floor(bit / 8)] |= 1 << (bit % 8);
    }
  }

  has(value: string): boolean {
    return this.bits(value).every((bit) => (
      (this.bytes[Math.floor(bit / 8)] & (1 << (bit % 8))) !== 0
    ));
  }

  clear(): void {
    this.bytes.fill(0);
  }

  private bits(value: string): number[] {
    const digest = createHash('sha256').update(value, 'utf8').digest();
    return [0, 4, 8, 12].map((offset) => digest.readUInt32BE(offset) % ARCHIVED_TOMBSTONE_BITS);
  }
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

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
  private readonly retiredEvidence = new Map<string, EvidenceTombstone>();
  private readonly archivedTombstones = new ArchivedTombstoneFilter();
  private readonly evidenceByNormalizedKey = new Map<string, Set<string>>();
  private readonly itemKeysByNormalizedKey = new Map<string, Set<string>>();
  private readonly invalidatedGenerations = new Map<string, InvalidatedGeneration>();
  private readonly ready = new Map<string, ReadyTransition>();
  private readonly maxEvidenceTombstones: number;
  private readonly tombstoneLifetimeMs: number;
  private latestRecordOrder = 0;
  private latestTombstoneOrder = 0;

  constructor(
    private readonly retentionMs = DEFAULT_RETENTION_MS,
    private readonly now: () => number = Date.now,
    tombstones: CodexProvenanceLedgerTombstoneOptions = {},
  ) {
    nonNegativeFinite(retentionMs, 'retentionMs');
    this.maxEvidenceTombstones = nonNegativeInteger(
      tombstones.maxEvidenceTombstones ?? DEFAULT_MAX_EVIDENCE_TOMBSTONES,
      'maxEvidenceTombstones',
    );
    this.tombstoneLifetimeMs = nonNegativeFinite(
      tombstones.tombstoneLifetimeMs ?? DEFAULT_TOMBSTONE_LIFETIME_MS,
      'tombstoneLifetimeMs',
    );
  }

  record(notification: CodexProvenanceNotification): void {
    const threadId = notification.params.threadId;
    const turnId = notification.params.turnId;
    const itemId = notification.method === 'item/completed'
      ? notification.params.item.id
      : notification.params.itemId;
    const key = itemKey(threadId, turnId, itemId);
    if (this.archivedTombstones.has(`item:${key}`)) return;
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
        order: ++this.latestRecordOrder,
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
    this.evidenceByNormalizedKey.clear();
    this.itemKeysByNormalizedKey.clear();
    const groups = new Map<string, NormalizedEvidenceGroup>();

    for (const item of this.items.values()) {
      if (item.invalid
        || item.terminalStatus !== 'completed'
        || this.archivedTombstones.has(`item:${item.key}`)) continue;
      for (const change of item.changes) {
        const evidence = evidenceKey(item, change.path);
        const accepted = resolveAcceptedPath(change.path);
        if (accepted === undefined) continue;
        const key = accepted.uri.toString();
        const currentEvidence = this.evidenceByNormalizedKey.get(key) ?? new Set<string>();
        const currentItemKeys = this.itemKeysByNormalizedKey.get(key) ?? new Set<string>();
        currentEvidence.add(evidence);
        currentItemKeys.add(item.key);
        this.evidenceByNormalizedKey.set(key, currentEvidence);
        this.itemKeysByNormalizedKey.set(key, currentItemKeys);
        if (this.invalidatedGenerationBlocks(key, item, evidence)) continue;
        if (this.isRetiredEvidence(evidence)) continue;
        const existing = groups.get(key);
        const group = existing ?? {
          accepted,
          links: [],
          evidence: new Set<string>(),
          itemKeys: new Set<string>(),
          acceptedStateConflict: false,
        };
        if (existing !== undefined
          && (accepted.exists !== existing.accepted.exists || accepted.text !== existing.accepted.text)) {
          group.acceptedStateConflict = true;
        }
        group.links.push({ item, change });
        group.evidence.add(evidence);
        group.itemKeys.add(item.key);
        groups.set(key, group);
      }
    }

    for (const [key, group] of groups) {
      const { accepted, evidence, links } = group;
      const first = links[0].item;
      if (group.acceptedStateConflict || (!accepted.exists && accepted.text !== '')
        || links.some(({ item }) => item.threadId !== first.threadId || item.turnId !== first.turnId)) {
        this.invalidateGeneration(key, group.itemKeys, evidence);
        continue;
      }

      const before = { uri: accepted.uri, exists: accepted.exists, text: accepted.text };
      let current: ProvenanceFileState = before;
      let precedingAfterHash = sha256Text(current.text);
      const itemIds: string[] = [];
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
      }

      if (!valid) {
        this.invalidateGeneration(key, group.itemKeys, evidence);
        continue;
      }
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
      this.ready.set(key, { transition, afterHash: precedingAfterHash, evidence: [...evidence] });
    }

    return [...this.ready.values()].map(({ transition }) => transition);
  }

  consume(key: string, afterHash: string): ExactCodexTransition | undefined {
    const ready = this.ready.get(key);
    if (ready === undefined || ready.afterHash !== afterHash) return undefined;
    this.retireEvidence(ready.evidence);
    this.ready.delete(key);
    return ready.transition;
  }

  invalidate(key: string): void {
    const evidence = this.evidenceByNormalizedKey.get(key);
    const itemKeys = this.itemKeysByNormalizedKey.get(key);
    if (evidence !== undefined && itemKeys !== undefined) {
      this.invalidateGeneration(key, itemKeys, evidence);
    }
    this.ready.delete(key);
  }

  retireKey(key: string, additionalItemKeys: Iterable<string> = []): void {
    const itemKeys = new Set([
      ...(this.itemKeysByNormalizedKey.get(key) ?? []),
      ...(this.invalidatedGenerations.get(key)?.itemKeys ?? []),
      ...additionalItemKeys,
    ]);
    const evidence = new Set([
      ...(this.evidenceByNormalizedKey.get(key) ?? []),
      ...(this.invalidatedGenerations.get(key)?.evidence ?? []),
    ]);
    if (itemKeys.size > 0 || evidence.size > 0) {
      this.invalidateGeneration(key, itemKeys, evidence);
    }
    const generation = this.invalidatedGenerations.get(key);
    if (generation !== undefined) {
      generation.cleanupWatermark = Math.max(generation.cleanupWatermark, this.latestRecordOrder);
      generation.cleanupComplete = true;
    }
    this.ready.delete(key);
    this.evidenceByNormalizedKey.delete(key);
    this.itemKeysByNormalizedKey.delete(key);
  }

  clear(): void {
    this.items.clear();
    this.retiredEvidence.clear();
    this.archivedTombstones.clear();
    this.evidenceByNormalizedKey.clear();
    this.itemKeysByNormalizedKey.clear();
    this.invalidatedGenerations.clear();
    this.ready.clear();
    this.latestRecordOrder = 0;
    this.latestTombstoneOrder = 0;
  }

  prune(now: number): void {
    let changed = false;
    for (const [key, item] of this.items) {
      if (item.updatedAt + this.retentionMs <= now) {
        this.items.delete(key);
        changed = true;
      }
    }
    if (changed) {
      for (const generation of this.invalidatedGenerations.values()) {
        if (!generation.cleanupComplete
          && ![...generation.itemKeys].some((key) => this.items.has(key))) {
          generation.cleanupWatermark = Math.max(
            generation.cleanupWatermark,
            this.latestRecordOrder,
          );
          generation.cleanupComplete = true;
        }
      }
      this.evidenceByNormalizedKey.clear();
      this.itemKeysByNormalizedKey.clear();
      this.ready.clear();
    }
    this.pruneEvidenceTombstones(now);
  }

  private retireEvidence(evidence: Iterable<string>): void {
    for (const value of evidence) this.rememberRetiredEvidence(value);
    this.enforceEvidenceTombstoneBound();
  }

  private invalidateGeneration(
    key: string,
    itemKeys: Iterable<string>,
    evidence: Iterable<string>,
  ): void {
    const generation = this.invalidatedGenerations.get(key) ?? {
      evidence: new Set<string>(),
      itemKeys: new Set<string>(),
      cleanupWatermark: 0,
      cleanupComplete: false,
      expiresAt: this.now() + this.tombstoneLifetimeMs,
      order: ++this.latestTombstoneOrder,
    };
    for (const itemKey of itemKeys) generation.itemKeys.add(itemKey);
    for (const value of evidence) generation.evidence.add(value);
    generation.cleanupComplete = false;
    generation.expiresAt = this.now() + this.tombstoneLifetimeMs;
    generation.order = ++this.latestTombstoneOrder;
    for (const value of generation.evidence) this.rememberRetiredEvidence(value);
    this.invalidatedGenerations.delete(key);
    this.invalidatedGenerations.set(key, generation);
    this.enforceEvidenceTombstoneBound();
  }

  private invalidatedGenerationBlocks(
    key: string,
    item: ItemRecord,
    evidence: string,
  ): boolean {
    const generation = this.invalidatedGenerations.get(key);
    if (generation === undefined) return false;

    if (item.order <= generation.cleanupWatermark) {
      generation.evidence.add(evidence);
      this.rememberRetiredEvidence(evidence);
      this.touchGeneration(key, generation);
      this.enforceEvidenceTombstoneBound();
      return true;
    }

    if (!generation.cleanupComplete) {
      generation.itemKeys.add(item.key);
      generation.evidence.add(evidence);
      this.rememberRetiredEvidence(evidence);
      this.touchGeneration(key, generation);
      this.enforceEvidenceTombstoneBound();
      return true;
    }

    return false;
  }

  private isRetiredEvidence(evidence: string): boolean {
    return this.retiredEvidence.has(evidence)
      || this.archivedTombstones.has(`evidence:${evidence}`);
  }

  private rememberRetiredEvidence(evidence: string): void {
    this.retiredEvidence.delete(evidence);
    this.retiredEvidence.set(evidence, {
      expiresAt: this.now() + this.tombstoneLifetimeMs,
      order: ++this.latestTombstoneOrder,
    });
  }

  private touchGeneration(key: string, generation: InvalidatedGeneration): void {
    generation.expiresAt = this.now() + this.tombstoneLifetimeMs;
    generation.order = ++this.latestTombstoneOrder;
    this.invalidatedGenerations.delete(key);
    this.invalidatedGenerations.set(key, generation);
  }

  private pruneEvidenceTombstones(now: number): void {
    for (const [evidence, tombstone] of [...this.retiredEvidence]) {
      if (tombstone.expiresAt <= now) this.archiveEvidence(evidence);
    }
    for (const [key, generation] of [...this.invalidatedGenerations]) {
      if (generation.expiresAt <= now) this.archiveGeneration(key, generation);
    }
    this.enforceEvidenceTombstoneBound();
  }

  private enforceEvidenceTombstoneBound(): void {
    while (this.evidenceTombstoneCount() > this.maxEvidenceTombstones) {
      const evidenceEntry = [...this.retiredEvidence.entries()][0];
      const generationEntry = [...this.invalidatedGenerations.entries()][0];
      if (evidenceEntry === undefined && generationEntry === undefined) return;
      if (generationEntry === undefined
        || (evidenceEntry !== undefined && evidenceEntry[1].order <= generationEntry[1].order)) {
        this.archiveEvidence(evidenceEntry![0]);
      } else {
        this.archiveGeneration(generationEntry[0], generationEntry[1]);
      }
    }
  }

  private evidenceTombstoneCount(): number {
    let count = this.retiredEvidence.size + this.invalidatedGenerations.size;
    for (const generation of this.invalidatedGenerations.values()) {
      count += generation.itemKeys.size;
    }
    return count;
  }

  private archiveEvidence(evidence: string): void {
    this.archivedTombstones.add(`evidence:${evidence}`);
    this.retiredEvidence.delete(evidence);
  }

  private archiveGeneration(key: string, generation: InvalidatedGeneration): void {
    for (const item of generation.itemKeys) {
      this.archivedTombstones.add(`item:${item}`);
    }
    for (const evidence of generation.evidence) {
      this.archivedTombstones.add(`evidence:${evidence}`);
      this.retiredEvidence.delete(evidence);
    }
    this.invalidatedGenerations.delete(key);
  }
}
