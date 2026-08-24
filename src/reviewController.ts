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
  applyReplacement(
    document: LiveReviewDocument,
    replacement: TextReplacement,
  ): Promise<boolean>;
  replaceAll(document: LiveReviewDocument, text: string): Promise<boolean>;
  deleteToTrash(uri: vscode.Uri): Promise<void>;
  reveal(document: LiveReviewDocument, line: number): void;
  showError(message: string): void;
  log(scope: string, error: unknown): void;
}

type ReviewCoordinator = Pick<
  ComparisonCoordinator,
  'state' | 'resolveHunk' | 'approveHunk' | 'approveAll' | 'delete'
>;

interface ResolvedHunkAction {
  readonly document: LiveReviewDocument;
  readonly state: FileComparisonState;
  readonly hunk: ChangeHunk;
}

const REJECT_ERROR = 'Could not reject Codex changes.';
const REJECT_SCOPE = 'Reject Codex changes';

export class ReviewController implements vscode.Disposable {
  private disposed = false;

  constructor(
    private readonly coordinator: ReviewCoordinator,
    private readonly host: ReviewHost,
    private readonly onStateChanged: (key: string) => void = () => {},
  ) {}

  async approveHunk(reference: HunkReference): Promise<void> {
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
  }

  async rejectHunk(reference: HunkReference): Promise<void> {
    const initial = this.resolveHunkAction(reference);
    if (initial === undefined) {
      return;
    }

    const current = this.resolveHunkAction(reference, initial.document.version);
    if (current === undefined) {
      return;
    }

    try {
      if (current.state.createdFile) {
        await this.host.deleteToTrash(current.document.uri);
        this.coordinator.delete(reference.key);
      } else {
        const replacement = rejectedHunkReplacement(current.document.text, current.hunk);
        const applied = await this.host.applyReplacement(current.document, replacement);
        if (!applied) {
          throw new Error('VS Code did not apply the rejection edit.');
        }
      }
      this.onStateChanged(reference.key);
    } catch (error) {
      this.reportRejectionFailure(error);
    }
  }

  async approveAll(uri?: vscode.Uri): Promise<void> {
    const initial = this.resolveActiveState(uri);
    if (initial === undefined) {
      return;
    }

    const current = this.resolveActiveState(
      uri,
      initial.document.version,
      initial.state.sourceRevision,
    );
    if (current === undefined) {
      return;
    }

    this.coordinator.approveAll(current.document.key, current.document.text);
    this.synchronize(current.document.key);
  }

  async rejectAll(uri?: vscode.Uri): Promise<void> {
    const initial = this.resolveActiveState(uri);
    if (initial === undefined) {
      return;
    }

    const current = this.resolveActiveState(
      uri,
      initial.document.version,
      initial.state.sourceRevision,
    );
    if (current === undefined) {
      return;
    }

    try {
      if (current.state.createdFile) {
        await this.host.deleteToTrash(current.document.uri);
        this.coordinator.delete(current.document.key);
      } else {
        const applied = await this.host.replaceAll(
          current.document,
          current.state.baselineText,
        );
        if (!applied) {
          throw new Error('VS Code did not apply the rejection edit.');
        }
      }
      this.onStateChanged(current.document.key);
    } catch (error) {
      this.reportRejectionFailure(error);
    }
  }

  previousChange(uri?: vscode.Uri): void {
    this.navigate('previous', uri);
  }

  nextChange(uri?: vscode.Uri): void {
    this.navigate('next', uri);
  }

  dispose(): void {
    this.disposed = true;
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
      || state.hunks.length === 0
      || state.currentText !== document.text
      || (expectedRevision !== undefined && state.sourceRevision !== expectedRevision)
    ) {
      this.synchronize(document.key);
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
      || state.currentText !== document.text
    ) {
      return;
    }

    const index = targetReviewIndex(state.hunks, document.cursorLine, direction);
    if (index === undefined) {
      return;
    }
    this.host.reveal(document, reviewAnchor(state.hunks[index]));
  }

  private synchronize(key: string): void {
    if (!this.disposed) {
      this.onStateChanged(key);
    }
  }

  private reportRejectionFailure(error: unknown): void {
    this.host.log(REJECT_SCOPE, error);
    this.host.showError(REJECT_ERROR);
  }
}
