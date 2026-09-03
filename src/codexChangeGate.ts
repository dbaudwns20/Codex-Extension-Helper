import type * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import {
  CodexProvenanceLedger,
  type AcceptedStateResolver,
  type ExactCodexTransition,
  type ProvenanceFileState,
} from './codexProvenanceLedger';
import {
  parseCodexProvenanceNotification,
  type CodexProvenanceNotification,
} from './codexProvenanceProtocol';
import { sha256Text } from './unifiedFilePatch';

export type FileSystemCandidate =
  | {
    readonly kind: 'present';
    readonly key: string;
    readonly uri: vscode.Uri;
    readonly text: string;
    readonly bytes: Uint8Array;
  }
  | { readonly kind: 'absent'; readonly key: string; readonly uri: vscode.Uri };

export interface CodexChangeGateCallbacks {
  onProven(transition: ExactCodexTransition): Promise<void>;
  onUnproven(candidate: FileSystemCandidate): Promise<void>;
}

export interface CodexChangeGateOptions {
  readonly resolveAcceptedPath: AcceptedStateResolver;
  readonly resolveWorkspacePath: (path: string) => vscode.Uri | undefined;
  readonly callbacks: CodexChangeGateCallbacks;
  readonly quarantineMs?: number;
  readonly transitionLifetimeMs?: number;
  readonly maxPendingCandidates?: number;
  readonly maxEligibleTransitions?: number;
  readonly diagnosticIntervalMs?: number;
  readonly onDiagnostic?: (message: string) => void;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly ledger?: CodexProvenanceLedger;
}

interface PendingCandidate {
  readonly candidate: FileSystemCandidate;
  readonly expiresAt: number;
}

interface EligibleTransition {
  readonly transition: ExactCodexTransition;
  readonly identity: string;
  readonly expiresAt: number;
}

interface ProvenCandidateIdentity {
  readonly identity: string;
  readonly itemKeys: ReadonlySet<string>;
  readonly expiresAt: number;
}

interface RejectedItemTombstone {
  readonly expiresAt: number;
  readonly order: number;
}

interface AwaitingCandidateEvidence {
  readonly keys: ReadonlySet<string>;
  readonly expiresAt: number;
}

interface NotificationKeyResolution {
  readonly relevantKeys: Set<string>;
  readonly awaitingCandidateKeys: Set<string>;
  readonly resolverAgreementFailed: boolean;
}

const DEFAULT_QUARANTINE_MS = 1_000;
// Completed evidence must outlive the extension's maximum 5-second watcher
// debounce, plus bounded disk-read and gate-correlation time.
export const DEFAULT_CODEX_TRANSITION_LIFETIME_MS = 15_000;
const DEFAULT_MAX_PENDING_CANDIDATES = 256;
const DEFAULT_MAX_ELIGIBLE_TRANSITIONS = 256;
const DEFAULT_DIAGNOSTIC_INTERVAL_MS = 30_000;
const MALFORMED_NOTIFICATION_DIAGNOSTIC =
  'Rejected a malformed Codex provenance notification.';
const REJECTED_ITEM_ARCHIVE_BITS = 65_536;

class RejectedItemArchive {
  private readonly bytes = new Uint8Array(REJECTED_ITEM_ARCHIVE_BITS / 8);

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
    return [0, 4, 8, 12]
      .map((offset) => digest.readUInt32BE(offset) % REJECTED_ITEM_ARCHIVE_BITS);
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

function changesOf(notification: CodexProvenanceNotification) {
  return notification.method === 'item/completed'
    ? notification.params.item.changes
    : notification.params.changes;
}

function notificationItemKey(notification: CodexProvenanceNotification): string {
  const itemId = notification.method === 'item/completed'
    ? notification.params.item.id
    : notification.params.itemId;
  return `${notification.params.threadId}\0${notification.params.turnId}\0${itemId}`;
}

function candidateHash(candidate: FileSystemCandidate): string {
  return candidate.kind === 'present'
    ? createHash('sha256').update(candidate.bytes).digest('hex')
    : sha256Text('');
}

function candidateIdentity(candidate: FileSystemCandidate): string {
  return JSON.stringify([candidate.kind, candidateHash(candidate)]);
}

function transitionIdentity(transition: ExactCodexTransition): string {
  return JSON.stringify([
    transition.key,
    transition.before.exists,
    sha256Text(transition.before.text),
    transition.after.exists,
    sha256Text(transition.after.text),
    transition.provenance.threadId,
    transition.provenance.turnId,
    transition.provenance.itemIds,
  ]);
}

function candidateMatchesTransition(
  candidate: FileSystemCandidate,
  transition: ExactCodexTransition,
): boolean {
  if (candidate.kind === 'absent') return !transition.after.exists;
  return transition.after.exists
    && Buffer.from(candidate.bytes).equals(Buffer.from(transition.after.text, 'utf8'));
}

export class CodexChangeGate implements vscode.Disposable {
  private readonly pendingCandidates = new Map<string, PendingCandidate>();
  private readonly shadowCandidates = new Map<string, PendingCandidate>();
  private readonly provenCandidateIdentities = new Map<string, ProvenCandidateIdentity>();
  private readonly eligibleTransitions = new Map<string, EligibleTransition>();
  private readonly inProgressItemKeys = new Map<string, Set<string>>();
  private readonly rejectedItems = new Map<string, RejectedItemTombstone>();
  private readonly awaitingCandidateItems = new Map<string, AwaitingCandidateEvidence>();
  private readonly knownAcceptedKeys = new Set<string>();
  private readonly archivedRejectedItems = new RejectedItemArchive();
  private readonly quarantineMs: number;
  private readonly transitionLifetimeMs: number;
  private readonly maxPendingCandidates: number;
  private readonly maxEligibleTransitions: number;
  private readonly diagnosticIntervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly ledger: CodexProvenanceLedger;
  private operationTail: Promise<void> = Promise.resolve();
  private timer: unknown;
  private nextMalformedDiagnosticAt = Number.NEGATIVE_INFINITY;
  private latestRejectedItemOrder = 0;
  private disposeRequested = false;

  constructor(private readonly options: CodexChangeGateOptions) {
    this.quarantineMs = nonNegativeFinite(
      options.quarantineMs ?? DEFAULT_QUARANTINE_MS,
      'quarantineMs',
    );
    this.transitionLifetimeMs = nonNegativeFinite(
      options.transitionLifetimeMs ?? DEFAULT_CODEX_TRANSITION_LIFETIME_MS,
      'transitionLifetimeMs',
    );
    this.maxPendingCandidates = nonNegativeInteger(
      options.maxPendingCandidates ?? DEFAULT_MAX_PENDING_CANDIDATES,
      'maxPendingCandidates',
    );
    this.maxEligibleTransitions = nonNegativeInteger(
      options.maxEligibleTransitions ?? DEFAULT_MAX_ELIGIBLE_TRANSITIONS,
      'maxEligibleTransitions',
    );
    this.diagnosticIntervalMs = nonNegativeFinite(
      options.diagnosticIntervalMs ?? DEFAULT_DIAGNOSTIC_INTERVAL_MS,
      'diagnosticIntervalMs',
    );
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.ledger = options.ledger ?? new CodexProvenanceLedger(
      Math.max(this.quarantineMs, this.transitionLifetimeMs),
      this.now,
    );
  }

  handleNotification(value: unknown): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposeRequested) return;
      const notification = parseCodexProvenanceNotification(value);
      if (notification === undefined) {
        this.diagnoseMalformedNotification();
        return;
      }

      let firstError: unknown;
      try {
        await this.sweep(this.now());
      } catch (error) {
        firstError = error;
      }
      const resolution = this.resolveNotificationKeys(notification);
      const itemKey = notificationItemKey(notification);
      for (const key of resolution.relevantKeys) {
        const proven = this.provenCandidateIdentities.get(key);
        if (proven !== undefined && !proven.itemKeys.has(itemKey)) {
          this.provenCandidateIdentities.delete(key);
          const shadow = this.shadowCandidates.get(key);
          if (shadow !== undefined) {
            this.shadowCandidates.delete(key);
            this.pendingCandidates.set(key, shadow);
          }
        }
      }
      try {
        await this.enforceCandidateBound();
      } catch (error) {
        firstError ??= error;
      }
      if (resolution.resolverAgreementFailed || this.isRejectedItem(itemKey)) {
        this.awaitingCandidateItems.delete(itemKey);
        this.rejectItem(itemKey);
        for (const key of resolution.relevantKeys) {
          this.eligibleTransitions.delete(key);
          this.ledger.invalidate(key);
        }
        for (const key of resolution.relevantKeys) {
          try {
            await this.match(key, true);
          } catch (error) {
            firstError ??= error;
          }
        }
        this.armTimer();
        if (firstError !== undefined) throw firstError;
        return;
      }

      for (const key of resolution.relevantKeys) {
        if (notification.method === 'item/fileChange/patchUpdated') {
          const itemKeys = this.inProgressItemKeys.get(key) ?? new Set<string>();
          itemKeys.add(itemKey);
          this.inProgressItemKeys.set(key, itemKeys);
        } else {
          const itemKeys = this.inProgressItemKeys.get(key);
          itemKeys?.delete(itemKey);
          if (itemKeys?.size === 0) this.inProgressItemKeys.delete(key);
        }
      }

      const previouslyEligible = new Set(this.eligibleTransitions.keys());
      this.ledger.record(notification);
      if (notification.method === 'item/completed'
        && resolution.awaitingCandidateKeys.size > 0) {
        this.awaitingCandidateItems.set(itemKey, {
          keys: resolution.awaitingCandidateKeys,
          expiresAt: this.now() + this.transitionLifetimeMs,
        });
      }
      this.refreshEligibleTransitions(this.now());

      for (const key of resolution.relevantKeys) {
        const terminal = notification.method === 'item/completed';
        const becameIneligible = previouslyEligible.has(key)
          && !this.eligibleTransitions.has(key);
        try {
          await this.match(key, terminal || becameIneligible);
        } catch (error) {
          firstError ??= error;
        }
        if (terminal
          && !this.eligibleTransitions.has(key)
          && !resolution.awaitingCandidateKeys.has(key)
          && !this.provenCandidateIdentities.get(key)?.itemKeys.has(itemKey)) {
          this.ledger.retireKey(key, [itemKey]);
        }
      }
      this.armTimer();
      if (firstError !== undefined) throw firstError;
    });
  }

  handleCandidate(candidate: FileSystemCandidate): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposeRequested) {
        await this.options.callbacks.onUnproven(candidate);
        return;
      }

      let firstError: unknown;
      try {
        await this.sweep(this.now());
      } catch (error) {
        firstError = error;
      }
      const identity = candidateIdentity(candidate);
      if (this.provenCandidateIdentities.get(candidate.key)?.identity === identity) {
        const existingShadow = this.shadowCandidates.get(candidate.key);
        if (existingShadow === undefined
          || candidateIdentity(existingShadow.candidate) !== identity) {
          this.shadowCandidates.delete(candidate.key);
          this.shadowCandidates.set(candidate.key, {
            candidate,
            expiresAt: this.now() + this.quarantineMs,
          });
          this.enforceShadowBound();
        }
        this.armTimer();
        if (firstError !== undefined) throw firstError;
        return;
      }
      this.provenCandidateIdentities.delete(candidate.key);
      this.shadowCandidates.delete(candidate.key);

      const existing = this.pendingCandidates.get(candidate.key);
      if (existing !== undefined) {
        if (candidateIdentity(existing.candidate) === identity) {
          this.armTimer();
          if (firstError !== undefined) throw firstError;
          return;
        }
        this.pendingCandidates.delete(candidate.key);
        try {
          await this.options.callbacks.onUnproven(existing.candidate);
        } catch (error) {
          firstError ??= error;
        }
      }

      this.pendingCandidates.set(candidate.key, {
        candidate,
        expiresAt: this.now() + this.quarantineMs,
      });
      this.refreshEligibleTransitions(this.now());
      try {
        await this.enforceCandidateBound();
      } catch (error) {
        firstError ??= error;
      }
      try {
        await this.match(candidate.key, false);
      } catch (error) {
        firstError ??= error;
      }
      this.armTimer();
      if (firstError !== undefined) throw firstError;
    });
  }

  invalidate(key: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposeRequested) return;

      const retiredItemKeys = new Set(this.inProgressItemKeys.get(key) ?? []);
      for (const itemKey of retiredItemKeys) {
        this.rejectItem(itemKey);
      }
      const eligible = this.eligibleTransitions.get(key);
      if (eligible !== undefined) {
        for (const itemId of eligible.transition.provenance.itemIds) {
          const itemKey = `${eligible.transition.provenance.threadId}\0${eligible.transition.provenance.turnId}\0${itemId}`;
          retiredItemKeys.add(itemKey);
          this.rejectItem(itemKey);
        }
      }
      for (const itemKey of this.provenCandidateIdentities.get(key)?.itemKeys ?? []) {
        retiredItemKeys.add(itemKey);
        this.rejectItem(itemKey);
      }
      for (const [itemKey, awaiting] of this.awaitingCandidateItems) {
        if (!awaiting.keys.has(key)) continue;
        retiredItemKeys.add(itemKey);
        this.rejectItem(itemKey);
        this.awaitingCandidateItems.delete(itemKey);
      }

      this.pendingCandidates.delete(key);
      this.shadowCandidates.delete(key);
      this.provenCandidateIdentities.delete(key);
      this.eligibleTransitions.delete(key);
      this.inProgressItemKeys.delete(key);
      this.knownAcceptedKeys.delete(key);
      this.ledger.retireKey(key, retiredItemKeys);
      this.armTimer();
    });
  }

  invalidateAll(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposeRequested) return;

      this.cancelTimer();
      this.pendingCandidates.clear();
      this.shadowCandidates.clear();
      this.provenCandidateIdentities.clear();
      this.eligibleTransitions.clear();
      this.inProgressItemKeys.clear();
      this.rejectedItems.clear();
      this.awaitingCandidateItems.clear();
      this.knownAcceptedKeys.clear();
      this.archivedRejectedItems.clear();
      this.latestRejectedItemOrder = 0;
      this.ledger.clear();
    });
  }

  dispose(): void {
    if (this.disposeRequested) return;
    this.disposeRequested = true;
    this.cancelTimer();
    void this.enqueue(async () => {
      const pending = [...this.pendingCandidates.values()];
      this.pendingCandidates.clear();
      this.shadowCandidates.clear();
      this.provenCandidateIdentities.clear();
      this.eligibleTransitions.clear();
      this.inProgressItemKeys.clear();
      this.rejectedItems.clear();
      this.awaitingCandidateItems.clear();
      this.knownAcceptedKeys.clear();
      this.archivedRejectedItems.clear();
      let firstError: unknown;
      for (const { candidate } of pending) {
        try {
          await this.options.callbacks.onUnproven(candidate);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    }).catch(() => undefined);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.catch(() => undefined);
    return result;
  }

  private resolveNotificationKeys(
    notification: CodexProvenanceNotification,
  ): NotificationKeyResolution {
    const relevantKeys = new Set<string>();
    const awaitingCandidateKeys = new Set<string>();
    let resolverAgreementFailed = false;
    for (const change of changesOf(notification)) {
      const workspaceKey = this.options.resolveWorkspacePath(change.path)?.toString();
      const acceptedKey = this.options.resolveAcceptedPath(change.path)?.uri.toString();
      if (workspaceKey !== undefined) relevantKeys.add(workspaceKey);
      if (acceptedKey !== undefined) relevantKeys.add(acceptedKey);
      if (workspaceKey !== undefined && acceptedKey === undefined) {
        if (this.knownAcceptedKeys.has(workspaceKey)) {
          resolverAgreementFailed = true;
        } else {
          awaitingCandidateKeys.add(workspaceKey);
        }
      }
      if (workspaceKey !== undefined && acceptedKey === workspaceKey) {
        this.knownAcceptedKeys.add(workspaceKey);
      }
      if (workspaceKey === undefined
        || (acceptedKey !== undefined && workspaceKey !== acceptedKey)) {
        resolverAgreementFailed = true;
      }
    }
    return { relevantKeys, awaitingCandidateKeys, resolverAgreementFailed };
  }

  private refreshEligibleTransitions(now: number): void {
    const previous = new Map(this.eligibleTransitions);
    const refreshed = new Map<string, EligibleTransition>();
    for (const transition of this.ledger.completedTransitions(
      this.options.resolveAcceptedPath,
      (path) => this.resolveObservedPath(path),
    )) {
      const rejected = transition.provenance.itemIds.some((itemId) => this.isRejectedItem(
        `${transition.provenance.threadId}\0${transition.provenance.turnId}\0${itemId}`,
      ));
      if (rejected) {
        this.ledger.invalidate(transition.key);
        continue;
      }
      const identity = transitionIdentity(transition);
      const existing = previous.get(transition.key);
      refreshed.set(transition.key, existing?.identity === identity
        ? { ...existing, transition }
        : { transition, identity, expiresAt: now + this.transitionLifetimeMs });
    }
    this.eligibleTransitions.clear();
    for (const [key, transition] of refreshed) {
      this.eligibleTransitions.set(key, transition);
    }
    while (this.eligibleTransitions.size > this.maxEligibleTransitions) {
      const oldestKey = this.eligibleTransitions.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.eligibleTransitions.delete(oldestKey);
      this.ledger.invalidate(oldestKey);
    }
  }

  private resolveObservedPath(path: string): ProvenanceFileState | undefined {
    const uri = this.options.resolveWorkspacePath(path);
    if (uri === undefined) return undefined;
    const candidate = this.pendingCandidates.get(uri.toString())?.candidate;
    if (candidate === undefined) return undefined;
    return candidate.kind === 'present'
      ? { uri: candidate.uri, exists: true, text: candidate.text }
      : { uri: candidate.uri, exists: false, text: '' };
  }

  private async match(key: string, definitiveFailure: boolean): Promise<void> {
    const pending = this.pendingCandidates.get(key);
    if (pending === undefined) return;
    const eligible = this.eligibleTransitions.get(key);

    if (eligible === undefined) {
      if (definitiveFailure) await this.unproveAndInvalidate(key, pending);
      return;
    }

    const { transition } = eligible;
    if (!candidateMatchesTransition(pending.candidate, transition)) {
      await this.unproveAndInvalidate(key, pending);
      return;
    }

    this.pendingCandidates.delete(key);
    this.eligibleTransitions.delete(key);
    const consumed = this.ledger.consume(key, sha256Text(transition.after.text));
    if (consumed === undefined) {
      this.ledger.invalidate(key);
      await this.options.callbacks.onUnproven(pending.candidate);
      return;
    }
    await this.options.callbacks.onProven(consumed);
    for (const itemId of consumed.provenance.itemIds) {
      this.awaitingCandidateItems.delete(
        `${consumed.provenance.threadId}\0${consumed.provenance.turnId}\0${itemId}`,
      );
    }
    this.provenCandidateIdentities.set(key, {
      identity: candidateIdentity(pending.candidate),
      itemKeys: new Set(consumed.provenance.itemIds.map((itemId) => (
        `${consumed.provenance.threadId}\0${consumed.provenance.turnId}\0${itemId}`
      ))),
      expiresAt: this.now() + this.transitionLifetimeMs,
    });
    this.enforceProvenIdentityBound();
  }

  private async unproveAndInvalidate(key: string, pending: PendingCandidate): Promise<void> {
    this.pendingCandidates.delete(key);
    this.provenCandidateIdentities.delete(key);
    this.eligibleTransitions.delete(key);
    this.ledger.invalidate(key);
    await this.options.callbacks.onUnproven(pending.candidate);
  }

  private async enforceCandidateBound(): Promise<void> {
    while (this.pendingCandidates.size > this.maxPendingCandidates) {
      const oldestKey = this.pendingCandidates.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      const oldest = this.pendingCandidates.get(oldestKey);
      this.pendingCandidates.delete(oldestKey);
      if (oldest !== undefined) await this.options.callbacks.onUnproven(oldest.candidate);
    }
  }

  private enforceShadowBound(): void {
    while (this.shadowCandidates.size > this.maxPendingCandidates) {
      const oldestKey = this.shadowCandidates.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      this.shadowCandidates.delete(oldestKey);
    }
  }

  private enforceProvenIdentityBound(): void {
    while (this.provenCandidateIdentities.size > this.maxEligibleTransitions) {
      const oldestKey = this.provenCandidateIdentities.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      this.provenCandidateIdentities.delete(oldestKey);
      this.shadowCandidates.delete(oldestKey);
    }
  }

  private rejectItem(itemKey: string): void {
    this.rejectedItems.delete(itemKey);
    this.rejectedItems.set(itemKey, {
      expiresAt: this.now() + this.transitionLifetimeMs,
      order: ++this.latestRejectedItemOrder,
    });
    while (this.rejectedItems.size > this.maxEligibleTransitions) {
      const oldestKey = this.rejectedItems.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      this.archiveRejectedItem(oldestKey);
    }
  }

  private isRejectedItem(itemKey: string): boolean {
    return this.rejectedItems.has(itemKey) || this.archivedRejectedItems.has(itemKey);
  }

  private archiveRejectedItem(itemKey: string): void {
    this.archivedRejectedItems.add(itemKey);
    this.rejectedItems.delete(itemKey);
  }

  private async sweep(now: number): Promise<void> {
    const expiredCandidates = [...this.pendingCandidates.entries()]
      .filter(([, pending]) => pending.expiresAt <= now);
    let firstError: unknown;
    for (const [key, pending] of expiredCandidates) {
      this.pendingCandidates.delete(key);
      try {
        await this.options.callbacks.onUnproven(pending.candidate);
      } catch (error) {
        firstError ??= error;
      }
    }

    for (const [key, eligible] of this.eligibleTransitions) {
      if (eligible.expiresAt <= now) {
        this.eligibleTransitions.delete(key);
        this.ledger.invalidate(key);
      }
    }
    for (const [key, shadow] of this.shadowCandidates) {
      if (shadow.expiresAt <= now) this.shadowCandidates.delete(key);
    }
    for (const [key, proven] of this.provenCandidateIdentities) {
      if (proven.expiresAt <= now) {
        this.provenCandidateIdentities.delete(key);
        this.shadowCandidates.delete(key);
      }
    }
    for (const [itemKey, tombstone] of this.rejectedItems) {
      if (tombstone.expiresAt <= now) this.archiveRejectedItem(itemKey);
    }
    for (const [itemKey, awaiting] of this.awaitingCandidateItems) {
      if (awaiting.expiresAt > now) continue;
      this.awaitingCandidateItems.delete(itemKey);
      this.rejectItem(itemKey);
      for (const key of awaiting.keys) {
        this.eligibleTransitions.delete(key);
        this.ledger.retireKey(key, [itemKey]);
      }
    }
    this.ledger.prune(now);
    if (firstError !== undefined) throw firstError;
  }

  private armTimer(): void {
    this.cancelTimer();
    if (this.disposeRequested) return;
    const expiries = [
      ...[...this.pendingCandidates.values()].map(({ expiresAt }) => expiresAt),
      ...[...this.shadowCandidates.values()].map(({ expiresAt }) => expiresAt),
      ...[...this.eligibleTransitions.values()].map(({ expiresAt }) => expiresAt),
      ...[...this.provenCandidateIdentities.values()].map(({ expiresAt }) => expiresAt),
      ...[...this.rejectedItems.values()].map(({ expiresAt }) => expiresAt),
      ...[...this.awaitingCandidateItems.values()].map(({ expiresAt }) => expiresAt),
    ];
    if (expiries.length === 0) return;
    const delayMs = Math.max(0, Math.min(...expiries) - this.now());
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.enqueue(async () => {
        try {
          await this.sweep(this.now());
        } finally {
          this.armTimer();
        }
      }).catch(() => undefined);
    }, delayMs);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private diagnoseMalformedNotification(): void {
    if (this.options.onDiagnostic === undefined || this.now() < this.nextMalformedDiagnosticAt) {
      return;
    }
    this.nextMalformedDiagnosticAt = this.now() + this.diagnosticIntervalMs;
    try {
      this.options.onDiagnostic(MALFORMED_NOTIFICATION_DIAGNOSTIC);
    } catch {
      // Diagnostic sinks must not alter provenance state or escape the command boundary.
    }
  }
}
