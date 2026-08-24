import type * as vscode from 'vscode';
import type { ChangeHunk } from './types';

const PREVIEW_LIMIT = 120;
const OPEN_DIFF_COMMAND = 'codexExtensionHelper.openDiff';

interface CodeLensApi {
  readonly languages: Pick<typeof vscode.languages, 'registerCodeLensProvider'>;
  readonly EventEmitter: typeof vscode.EventEmitter;
  readonly Range: typeof vscode.Range;
  readonly CodeLens: typeof vscode.CodeLens;
}

export class DeletedLinesCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly hunksByKey = new Map<string, readonly ChangeHunk[]>();
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

  update(key: string, hunks: readonly ChangeHunk[]): void {
    const deleted = hunks.filter((hunk) => hunk.originalLines.length > 0);
    if (deleted.length === 0) {
      this.hunksByKey.delete(key);
    } else {
      this.hunksByKey.set(key, deleted);
    }
    this.changeEmitter.fire();
  }

  clear(key: string): void {
    if (this.hunksByKey.delete(key)) {
      this.changeEmitter.fire();
    }
  }

  clearAll(): void {
    if (this.hunksByKey.size > 0) {
      this.hunksByKey.clear();
      this.changeEmitter.fire();
    }
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const hunks = this.hunksByKey.get(this.uriKey(document.uri)) ?? [];
    return hunks.map((hunk) => {
      const line = Math.min(Math.max(0, hunk.modifiedStart), document.lineCount - 1);
      return new this.api.CodeLens(
        new this.api.Range(line, 0, line, 0),
        {
          title: this.title(hunk.originalLines),
          command: OPEN_DIFF_COMMAND,
          tooltip: this.tooltip(hunk.originalLines),
        },
      );
    });
  }

  dispose(): void {
    this.hunksByKey.clear();
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
