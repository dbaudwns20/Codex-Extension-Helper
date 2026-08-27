import type * as vscode from 'vscode';
import type { ComparisonCoordinator } from './coordinator';
import { reviewAnchor, targetReviewIndex, type ReviewDirection } from './reviewNavigation';
import { rejectedHunkReplacement, type TextReplacement } from './reviewText';
import type { ChangeHunk, FileComparisonState, HunkReference } from './types';

export interface LiveReviewDocument {
  readonly uri: vscode.Uri;
  readonly key: string;
  readonly text: string;
  readonly version: number;
  readonly cursorLine: number;
  readonly lineCount: number;
  readonly eol: vscode.EndOfLine;
}

export interface ReviewHost {
  activeDocument(): LiveReviewDocument | undefined;
  reviewDocument(uri: vscode.Uri): Promise<LiveReviewDocument | undefined>;
  applyReplacement(
    document: LiveReviewDocument,
    replacement: TextReplacement,
  ): Promise<boolean>;
  replaceAll(document: LiveReviewDocument, text: string): Promise<boolean>;
  deleteToTrash(uri: vscode.Uri): Promise<void>;
  isFileAbsent(uri: vscode.Uri): Promise<boolean>;
  restoreDeletedFile(uri: vscode.Uri, text: string): Promise<boolean>;
  reveal(document: LiveReviewDocument, line: number): void;
  showError(message: string): void;
  log(scope: string, error: unknown): void;
}

type ReviewCoordinator = Pick<
  ComparisonCoordinator,
  | 'state'
  | 'resolveHunk'
  | 'approveHunk'
  | 'approveAll'
  | 'approveDeleted'
  | 'rejectDeleted'
  | 'delete'
>;

interface ResolvedHunkAction {
  readonly document: LiveReviewDocument;
  readonly state: FileComparisonState;
  readonly hunk: ChangeHunk;
}

const REJECT_ERROR = 'Could not reject Codex changes.';
const REJECT_SCOPE = 'Reject Codex changes';
const SYNCHRONIZE_SCOPE = 'Synchronize Codex review state';
const APPROVE_DELETED_ERROR = 'Could not approve the deleted Codex file.';
const APPROVE_DELETED_SCOPE = 'Approve deleted Codex file';

export class ReviewController implements vscode.Disposable {
  private readonly mutationTails = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly coordinator: ReviewCoordinator,
    private readonly host: ReviewHost,
    private readonly onStateChanged: (key: string) => void = () => {},
    private readonly prepareCanonicalDocument: (key: string) => Promise<boolean> = async () => true,
    private readonly canonicalTextForDisplay: (key: string, text: string) => string = (_key, text) => text,
    private readonly canonicalLineForDisplay: (key: string, line: number) => number = (_key, line) => line,
    private readonly reviewResources: () => readonly vscode.Uri[] = () => [],
  ) {}

  async approveAllFiles(): Promise<void> {
    for (const uri of [...this.reviewResources()]) {
      try {
        await this.approveFile(uri);
      } catch (error) {
        this.host.log('Approve all Codex files', error);
      }
    }
  }

  async approveHunk(reference: HunkReference): Promise<void> {
    await this.serializeMutation(reference.key, async () => {
      if (!await this.prepareCanonicalDocument(reference.key)) {
        return;
      }
      const initial = this.resolveHunkAction(reference);
      if (initial === undefined) {
        return;
      }

      const current = this.resolveHunkAction(reference, initial.document.version);
      if (current === undefined) {
        return;
      }

      await this.coordinator.approveHunk(reference);
      this.synchronize(reference.key);
    });
  }

  async rejectHunk(reference: HunkReference): Promise<void> {
    await this.serializeMutation(reference.key, async () => {
      if (!await this.prepareCanonicalDocument(reference.key)) {
        return;
      }
      const initial = this.resolveHunkAction(reference);
      if (initial === undefined) {
        return;
      }
      const current = this.resolveHunkAction(reference, initial.document.version);
      if (current === undefined) {
        return;
      }

      if (current.state.lifecycle === 'created') {
        try {
          await this.host.deleteToTrash(current.document.uri);
        } catch (error) {
          this.reportRejectionFailure(error);
          return;
        }
        this.finalizeCreatedFileRejection(reference.key);
      } else {
        try {
          const replacement = rejectedHunkReplacement(current.document.text, current.hunk);
          const applied = await this.host.applyReplacement(current.document, replacement);
          if (!applied) {
            throw new Error('VS Code did not apply the rejection edit.');
          }
        } catch (error) {
          this.reportRejectionFailure(error);
          return;
        }
      }
      this.synchronize(reference.key);
    });
  }

  async approveAll(uri?: vscode.Uri): Promise<void> {
    const key = this.mutationKey(uri);
    if (key === undefined) {
      return;
    }

    await this.serializeMutation(key, async () => {
      if (!await this.prepareCanonicalDocument(key)) {
        return;
      }
      const initial = this.resolveActiveState(uri);
      if (initial === undefined) {
        return;
      }
      if (initial.document.key !== key) {
        this.synchronize(key);
        return;
      }

      const current = this.resolveActiveState(
        uri,
        initial.document.version,
        initial.state.sourceRevision,
      );
      if (current === undefined || current.document.key !== key) {
        return;
      }

      this.coordinator.approveAll(current.document.key, current.document.text);
      this.synchronize(current.document.key);
    });
  }

  async approveFile(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    await this.serializeMutation(key, async () => {
      const deleted = this.deletedState(key);
      if (deleted !== undefined) {
        await this.approveDeletedFile(uri, deleted);
        return;
      }
      if (!await this.prepareCanonicalDocument(key)) {
        return;
      }
      const initial = await this.resolveResourceState(uri);
      if (initial === undefined) {
        return;
      }
      const current = await this.resolveResourceState(
        uri,
        initial.document.version,
        initial.state.sourceRevision,
      );
      if (current === undefined) {
        return;
      }
      this.coordinator.approveAll(key, current.document.text);
      this.synchronize(key);
    });
  }

  async rejectAll(uri?: vscode.Uri): Promise<void> {
    const key = this.mutationKey(uri);
    if (key === undefined) {
      return;
    }

    await this.serializeMutation(key, async () => {
      if (!await this.prepareCanonicalDocument(key)) {
        return;
      }
      const initial = this.resolveActiveState(uri);
      if (initial === undefined) {
        return;
      }
      if (initial.document.key !== key) {
        this.synchronize(key);
        return;
      }
      const current = this.resolveActiveState(
        uri,
        initial.document.version,
        initial.state.sourceRevision,
      );
      if (current === undefined || current.document.key !== key) {
        return;
      }

      if (current.state.lifecycle === 'created') {
        try {
          await this.host.deleteToTrash(current.document.uri);
        } catch (error) {
          this.reportRejectionFailure(error);
          return;
        }
        this.finalizeCreatedFileRejection(current.document.key);
      } else {
        try {
          const applied = await this.host.replaceAll(
            current.document,
            current.state.baselineText,
          );
          if (!applied) {
            throw new Error('VS Code did not apply the rejection edit.');
          }
        } catch (error) {
          this.reportRejectionFailure(error);
          return;
        }
      }
      this.synchronize(current.document.key);
    });
  }

  async rejectAllFiles(): Promise<void> {
    for (const uri of [...this.reviewResources()]) {
      try {
        await this.rejectFile(uri);
      } catch (error) {
        this.host.log('Reject all Codex files', error);
      }
    }
  }

  async rejectFile(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    await this.serializeMutation(key, async () => {
      const deleted = this.deletedState(key);
      if (deleted !== undefined) {
        await this.rejectDeletedFile(uri, deleted);
        return;
      }
      if (!await this.prepareCanonicalDocument(key)) {
        return;
      }
      const initial = await this.resolveResourceState(uri);
      if (initial === undefined) {
        return;
      }
      const current = await this.resolveResourceState(
        uri,
        initial.document.version,
        initial.state.sourceRevision,
      );
      if (current === undefined) {
        return;
      }

      if (current.state.lifecycle === 'created') {
        try {
          await this.host.deleteToTrash(uri);
        } catch (error) {
          this.reportRejectionFailure(error);
          return;
        }
        this.finalizeCreatedFileRejection(key);
      } else {
        try {
          const applied = await this.host.replaceAll(current.document, current.state.baselineText);
          if (!applied) {
            throw new Error('VS Code did not apply the rejection edit.');
          }
        } catch (error) {
          this.reportRejectionFailure(error);
          return;
        }
      }
      this.synchronize(key);
    });
  }

  previousChange(uri?: vscode.Uri): void {
    this.navigate('previous', uri);
  }

  nextChange(uri?: vscode.Uri): void {
    this.navigate('next', uri);
  }

  dispose(): void {
    this.disposed = true;
    this.mutationTails.clear();
  }

  private resolveHunkAction(
    reference: HunkReference,
    expectedVersion?: number,
  ): ResolvedHunkAction | undefined {
    if (this.disposed) {
      return undefined;
    }

    const document = this.host.activeDocument();
    if (
      document === undefined
      || document.key !== reference.key
      || document.text !== reference.expectedText
      || (expectedVersion !== undefined && document.version !== expectedVersion)
    ) {
      this.synchronize(reference.key);
      return undefined;
    }

    const resolved = this.coordinator.resolveHunk(reference);
    if (
      resolved.status !== 'ok'
      || resolved.state.lifecycle === 'deleted'
      || resolved.state.currentText !== document.text
    ) {
      this.synchronize(reference.key);
      return undefined;
    }

    return { document, state: resolved.state, hunk: resolved.hunk };
  }

  private resolveActiveState(
    uri?: vscode.Uri,
    expectedVersion?: number,
    expectedRevision?: number,
  ): { document: LiveReviewDocument; state: FileComparisonState } | undefined {
    if (this.disposed) {
      return undefined;
    }

    const document = this.host.activeDocument();
    const requestedKey = uri?.toString();
    if (
      document === undefined
      || (uri !== undefined && document.uri.toString() !== requestedKey)
      || (expectedVersion !== undefined && document.version !== expectedVersion)
    ) {
      if (requestedKey !== undefined) {
        this.synchronize(requestedKey);
      }
      return undefined;
    }

    const state = this.coordinator.state(document.key);
    if (
      state === undefined
      || !state.pending
      || state.lifecycle === 'deleted'
      || (state.hunks.length === 0 && state.lifecycle !== 'created')
      || state.currentText !== this.canonicalTextForDisplay(document.key, document.text)
      || (expectedRevision !== undefined && state.sourceRevision !== expectedRevision)
    ) {
      this.synchronize(document.key);
      return undefined;
    }

    return { document, state };
  }

  private async resolveResourceState(
    uri: vscode.Uri,
    expectedVersion?: number,
    expectedRevision?: number,
  ): Promise<{ document: LiveReviewDocument; state: FileComparisonState } | undefined> {
    if (this.disposed) {
      return undefined;
    }

    const key = uri.toString();
    const document = await this.host.reviewDocument(uri);
    if (
      document === undefined
      || document.key !== key
      || (expectedVersion !== undefined && document.version !== expectedVersion)
    ) {
      this.synchronize(key);
      return undefined;
    }

    const state = this.coordinator.state(key);
    if (
      state === undefined
      || !state.pending
      || (state.hunks.length === 0 && state.lifecycle !== 'created')
      || state.currentText !== this.canonicalTextForDisplay(key, document.text)
      || (expectedRevision !== undefined && state.sourceRevision !== expectedRevision)
    ) {
      this.synchronize(key);
      return undefined;
    }
    return { document, state };
  }

  private navigate(direction: ReviewDirection, uri?: vscode.Uri): void {
    if (this.disposed) {
      return;
    }

    const document = this.host.activeDocument();
    if (
      document === undefined
      || (uri !== undefined && document.uri.toString() !== uri.toString())
    ) {
      return;
    }

    const state = this.coordinator.state(document.key);
    if (
      state === undefined
      || !state.pending
      || state.currentText !== this.canonicalTextForDisplay(document.key, document.text)
    ) {
      return;
    }

    const index = targetReviewIndex(
      state.hunks,
      this.canonicalLineForDisplay(document.key, document.cursorLine),
      direction,
    );
    if (index === undefined) {
      return;
    }
    this.host.reveal(document, reviewAnchor(state.hunks[index]));
  }

  private deletedState(
    key: string,
    expectedRevision?: number,
  ): FileComparisonState | undefined {
    const state = this.coordinator.state(key);
    return state !== undefined
      && state.lifecycle === 'deleted'
      && state.comparisonActive
      && state.pending
      && state.currentText === ''
      && (expectedRevision === undefined || state.sourceRevision === expectedRevision)
      ? state
      : undefined;
  }

  private async approveDeletedFile(
    uri: vscode.Uri,
    initial: FileComparisonState,
  ): Promise<void> {
    try {
      if (!await this.host.isFileAbsent(uri)) {
        throw new Error('The deleted path now exists.');
      }
      const result = this.coordinator.approveDeleted(uri.toString(), initial.sourceRevision);
      if (result !== 'approved') {
        throw new Error(`The deleted comparison is ${result}.`);
      }
    } catch (error) {
      this.host.log(APPROVE_DELETED_SCOPE, error);
      if (!this.disposed) {
        this.host.showError(APPROVE_DELETED_ERROR);
      }
      return;
    }
    this.synchronize(uri.toString());
  }

  private async rejectDeletedFile(
    uri: vscode.Uri,
    initial: FileComparisonState,
  ): Promise<void> {
    try {
      if (!await this.host.isFileAbsent(uri)) {
        throw new Error('The deleted path now exists.');
      }
      const current = this.deletedState(uri.toString(), initial.sourceRevision);
      if (current === undefined) {
        throw new Error('The deleted comparison changed before restoration.');
      }
      if (!await this.host.restoreDeletedFile(uri, current.baselineText)) {
        throw new Error('The deleted path could not be restored without overwriting a file.');
      }
      const result = this.coordinator.rejectDeleted(uri.toString(), current.sourceRevision);
      if (result !== 'approved') {
        throw new Error(`The deleted comparison is ${result} after restoration.`);
      }
    } catch (error) {
      this.reportRejectionFailure(error);
      return;
    }
    this.synchronize(uri.toString());
  }

  private synchronize(key: string): void {
    if (this.disposed) {
      return;
    }
    try {
      this.onStateChanged(key);
    } catch (error) {
      this.host.log(SYNCHRONIZE_SCOPE, error);
    }
  }

  private mutationKey(uri?: vscode.Uri): string | undefined {
    if (this.disposed) {
      return undefined;
    }
    return uri?.toString() ?? this.host.activeDocument()?.key;
  }

  private async serializeMutation(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.mutationTails.get(key);
    const current = previous === undefined ? operation() : previous.then(operation);
    const settled = current.catch(() => {});
    this.mutationTails.set(key, settled);
    try {
      await current;
    } finally {
      if (this.mutationTails.get(key) === settled) {
        this.mutationTails.delete(key);
      }
    }
  }

  private reportRejectionFailure(error: unknown): void {
    this.host.log(REJECT_SCOPE, error);
    if (!this.disposed) {
      this.host.showError(REJECT_ERROR);
    }
  }

  private finalizeCreatedFileRejection(key: string): void {
    try {
      this.coordinator.delete(key);
    } catch (error) {
      this.host.log(SYNCHRONIZE_SCOPE, error);
    }
  }
}
