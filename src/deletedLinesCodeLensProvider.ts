import type * as vscode from 'vscode';
import type { ChangeHunk, HunkReference } from './types';

const PREVIEW_LIMIT = 120;
const OPEN_DIFF_COMMAND = 'codexExtensionHelper.openDiff';
const APPROVE_HUNK_COMMAND = 'codexExtensionHelper.approveHunk';
const REJECT_HUNK_COMMAND = 'codexExtensionHelper.rejectHunk';

export interface ReviewCodeLensState {
  readonly key: string;
  readonly sourceRevision: number;
  readonly currentText: string;
  readonly hunks: readonly ChangeHunk[];
}

interface CodeLensApi {
  readonly languages: Pick<typeof vscode.languages, 'registerCodeLensProvider'>;
  readonly EventEmitter: typeof vscode.EventEmitter;
  readonly Range: typeof vscode.Range;
  readonly CodeLens: typeof vscode.CodeLens;
}

export class DeletedLinesCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly statesByKey = new Map<string, ReviewCodeLensState>();
  private readonly changeEmitter: vscode.EventEmitter<void>;
  private readonly registration: vscode.Disposable;
  readonly onDidChangeCodeLenses: vscode.Event<void>;

  constructor(
    private readonly api: CodeLensApi,
    private readonly uriKey: (uri: vscode.Uri) => string = (uri) => uri.toString(),
  ) {
    this.changeEmitter = new api.EventEmitter<void>();
    this.onDidChangeCodeLenses = this.changeEmitter.event;
    this.registration = api.languages.registerCodeLensProvider({ scheme: 'file' }, this);
  }

  update(state: ReviewCodeLensState): void;
  /** Compatibility overload for callers that have not yet supplied review metadata. */
  update(key: string, hunks: readonly ChangeHunk[]): void;
  update(stateOrKey: ReviewCodeLensState | string, legacyHunks?: readonly ChangeHunk[]): void {
    const state = typeof stateOrKey === 'string'
      ? { key: stateOrKey, sourceRevision: 0, currentText: '', hunks: legacyHunks ?? [] }
      : stateOrKey;
    if (state.hunks.length === 0) {
      this.statesByKey.delete(state.key);
    } else {
      this.statesByKey.set(state.key, state);
    }
    this.changeEmitter.fire();
  }

  clear(key: string): void {
    if (this.statesByKey.delete(key)) {
      this.changeEmitter.fire();
    }
  }

  clearAll(): void {
    if (this.statesByKey.size > 0) {
      this.statesByKey.clear();
      this.changeEmitter.fire();
    }
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const state = this.statesByKey.get(this.uriKey(document.uri));
    if (state === undefined) {
      return [];
    }

    const finalLine = Math.max(0, document.lineCount - 1);
    return state.hunks.flatMap((hunk, hunkIndex) => {
      const line = Math.min(Math.max(0, hunk.modifiedStart), finalLine);
      const range = new this.api.Range(line, 0, line, 0);
      const lenses: vscode.CodeLens[] = [];

      if (hunk.originalLines.length > 0) {
        lenses.push(new this.api.CodeLens(
          range,
          {
            title: this.title(hunk.originalLines),
            command: OPEN_DIFF_COMMAND,
            tooltip: this.tooltip(hunk.originalLines),
          },
        ));
      }

      const reference: HunkReference = {
        key: state.key,
        sourceRevision: state.sourceRevision,
        hunkIndex,
        expectedText: state.currentText,
      };
      lenses.push(new this.api.CodeLens(range, {
        title: '$(check) Approve',
        command: APPROVE_HUNK_COMMAND,
        arguments: [reference],
      }));
      lenses.push(new this.api.CodeLens(range, {
        title: '$(close) Reject',
        command: REJECT_HUNK_COMMAND,
        arguments: [reference],
      }));
      return lenses;
    });
  }

  dispose(): void {
    this.statesByKey.clear();
    this.registration.dispose();
    this.changeEmitter.dispose();
  }

  private title(lines: readonly string[]): string {
    if (lines.length > 1) {
      return `− ${lines.length} deleted lines`;
    }
    const content = lines[0].length === 0 ? '(blank line)' : lines[0];
    const preview = content.length <= PREVIEW_LIMIT
      ? content
      : `${content.slice(0, PREVIEW_LIMIT - 1)}…`;
    return `− ${preview}`;
  }

  private tooltip(lines: readonly string[]): string {
    return `Deleted ${lines.length} line${lines.length === 1 ? '' : 's'}\n\n${lines.join('\n')}`;
  }
}
