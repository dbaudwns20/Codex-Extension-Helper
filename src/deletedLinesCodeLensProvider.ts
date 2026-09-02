import type * as vscode from 'vscode';
import type { ChangeHunk, HunkReference } from './types';

const APPROVE_HUNK_COMMAND = 'codexExtensionHelper.approveHunk';
const REJECT_HUNK_COMMAND = 'codexExtensionHelper.rejectHunk';

export interface ReviewCodeLensState {
  readonly key: string;
  readonly sourceRevision: number;
  readonly currentText: string;
  readonly hunks: readonly ChangeHunk[];
  readonly actionLines?: readonly number[];
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

  update(state: ReviewCodeLensState): void {
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
      const line = Math.min(
        Math.max(0, state.actionLines?.[hunkIndex] ?? hunk.modifiedStart),
        finalLine,
      );
      const character = document.lineAt(line).range.end.character;
      const range = new this.api.Range(line, character, line, character);
      const lenses: vscode.CodeLens[] = [];

      const reference: HunkReference = {
        key: state.key,
        sourceRevision: state.sourceRevision,
        hunkIndex,
        expectedText: state.currentText,
      };
      lenses.push(new this.api.CodeLens(range, {
        title: '$(check) Accept',
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

}
