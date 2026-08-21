import type * as vscode from 'vscode';
import type { ComparisonView } from './coordinator';
import type { ChangeHunk } from './types';

const INSET_WARNING = 'Codex Inline Changes could not render deleted lines. Use VS Code Insiders with the editorInsets proposed API enabled, then reload the window.';

export interface InsetPlacement {
  anchorLine: number;
  height: number;
}

interface InlineRendererApi {
  readonly window: {
    readonly visibleTextEditors: readonly vscode.TextEditor[];
    readonly tabGroups: Pick<vscode.TabGroups, 'all'>;
    createTextEditorDecorationType(
      options: vscode.DecorationRenderOptions,
    ): vscode.TextEditorDecorationType;
    createWebviewTextEditorInset?: (
      editor: vscode.TextEditor,
      line: number,
      height: number,
      options?: vscode.WebviewOptions,
    ) => vscode.WebviewEditorInset;
    showWarningMessage(message: string): Thenable<string | undefined>;
  };
  readonly Range: typeof vscode.Range;
  readonly ThemeColor: typeof vscode.ThemeColor;
  readonly DecorationRangeBehavior: typeof vscode.DecorationRangeBehavior;
  readonly OverviewRulerLane: typeof vscode.OverviewRulerLane;
  readonly TabInputText: typeof vscode.TabInputText;
}

interface ViewResources {
  readonly insets: vscode.WebviewEditorInset[];
}

export interface InlineRendererSessionState {
  renderingDisabled: boolean;
  warningShown: boolean;
}

export function createInlineRendererSessionState(): InlineRendererSessionState {
  return { renderingDisabled: false, warningShown: false };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function buildDeletedLinesHtml(
  lines: readonly string[],
  originalStart: number,
): string {
  const rows = lines.map((line, index) => {
    const lineNumber = Math.max(0, originalStart) + index + 1;
    return `<div class="line"><span class="gutter">${lineNumber}</span><span class="code">${escapeHtml(line)}</span></div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
html, body { margin: 0; padding: 0; color: var(--vscode-editor-foreground); background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.2)); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
.line { display: flex; min-height: var(--vscode-editor-line-height); white-space: pre; tab-size: var(--vscode-editor-tabSize, 4); }
.gutter { box-sizing: border-box; flex: 0 0 auto; min-width: 4ch; padding: 0 1ch 0 0.5ch; border-left: 3px solid var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); color: var(--vscode-editorLineNumber-foreground); text-align: right; user-select: none; }
.code { flex: 1 1 auto; padding-left: 1ch; }
</style>
</head>
<body>${rows}</body>
</html>`;
}

export function insetPlacementForHunk(
  hunk: ChangeHunk,
  modifiedLineCount: number,
): InsetPlacement {
  const insertionLine = Math.min(
    Math.max(0, hunk.modifiedStart),
    Math.max(0, modifiedLineCount),
  );

  return {
    anchorLine: insertionLine - 1,
    height: hunk.originalLines.length,
  };
}

export class InlineRenderer implements ComparisonView, vscode.Disposable {
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly resources = new Map<string, Map<vscode.TextEditor, ViewResources>>();
  private disposed = false;

  constructor(
    private readonly api: InlineRendererApi,
    private readonly output: Pick<vscode.OutputChannel, 'appendLine'>,
    private readonly uriKey: (uri: vscode.Uri) => string = (uri) => uri.toString(),
    private readonly sessionState: InlineRendererSessionState = createInlineRendererSessionState(),
  ) {
    this.decorationType = api.window.createTextEditorDecorationType({
      isWholeLine: true,
      rangeBehavior: api.DecorationRangeBehavior.ClosedClosed,
      backgroundColor: new api.ThemeColor('diffEditor.insertedTextBackground'),
      overviewRulerColor: new api.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: api.OverviewRulerLane.Full,
    });

    if (typeof api.window.createWebviewTextEditorInset !== 'function') {
      this.disableRendering(new Error('window.createWebviewTextEditorInset is unavailable'));
    }
  }

  async render(key: string, hunks: readonly ChangeHunk[]): Promise<void> {
    if (this.disposed || this.sessionState.renderingDisabled) {
      return;
    }

    if (typeof this.api.window.createWebviewTextEditorInset !== 'function') {
      this.disableRendering(new Error('window.createWebviewTextEditorInset is unavailable'));
      return;
    }

    this.clear(key);
    const editors = this.api.window.visibleTextEditors.filter(
      (editor) => this.uriKey(editor.document.uri) === key && this.isNormalTextEditor(editor),
    );
    if (editors.length === 0) {
      return;
    }

    const views = new Map<vscode.TextEditor, ViewResources>();
    this.resources.set(key, views);

    for (const editor of editors) {
      const insets: vscode.WebviewEditorInset[] = [];
      views.set(editor, { insets });

      try {
        editor.setDecorations(this.decorationType, this.greenRanges(hunks));

        for (const hunk of hunks) {
          if (hunk.originalLines.length === 0) {
            continue;
          }

          const placement = insetPlacementForHunk(hunk, editor.document.lineCount);
          const inset = this.api.window.createWebviewTextEditorInset(
            editor,
            placement.anchorLine,
            placement.height,
            { enableScripts: false },
          );
          insets.push(inset);
          inset.webview.html = buildDeletedLinesHtml(hunk.originalLines, hunk.originalStart);
        }
      } catch (error) {
        this.disableRendering(error);
        return;
      }
    }
  }

  hasRendered(key: string): boolean {
    return (this.resources.get(key)?.size ?? 0) > 0;
  }

  clear(key: string): void {
    const views = this.resources.get(key);
    if (views === undefined) {
      return;
    }

    try {
      for (const [editor, resources] of views) {
        this.cleanup(
          'clear editor decorations',
          () => editor.setDecorations(this.decorationType, []),
        );
        for (const inset of resources.insets) {
          this.cleanup('dispose editor inset', () => inset.dispose());
        }
      }
    } finally {
      if (this.resources.get(key) === views) {
        this.resources.delete(key);
      }
    }
  }

  clearAll(): void {
    for (const key of [...this.resources.keys()]) {
      this.clear(key);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.clearAll();
    this.cleanup('dispose decoration type', () => this.decorationType.dispose());
  }

  private isNormalTextEditor(editor: vscode.TextEditor): boolean {
    if (editor.viewColumn === undefined || typeof this.api.TabInputText !== 'function') {
      return false;
    }

    const group = this.api.window.tabGroups.all.find(
      (candidate) => candidate.viewColumn === editor.viewColumn,
    );
    const input = group?.activeTab?.input;
    return input instanceof this.api.TabInputText
      && this.uriKey(input.uri) === this.uriKey(editor.document.uri);
  }

  private greenRanges(hunks: readonly ChangeHunk[]): vscode.Range[] {
    return hunks.flatMap((hunk) => {
      if (
        hunk.kind === 'deletion'
        || hunk.modifiedEnd <= hunk.modifiedStart
      ) {
        return [];
      }

      return [new this.api.Range(
        hunk.modifiedStart,
        0,
        hunk.modifiedEnd - 1,
        0,
      )];
    });
  }

  private disableRendering(error: unknown): void {
    if (this.sessionState.renderingDisabled) {
      return;
    }

    this.sessionState.renderingDisabled = true;
    this.log('InlineRenderer', error);
    this.clearAll();

    if (!this.sessionState.warningShown) {
      this.sessionState.warningShown = true;
      try {
        void this.api.window.showWarningMessage(INSET_WARNING);
      } catch (warningError) {
        this.log('InlineRendererWarning', warningError);
      }
    }
  }

  private cleanup(operation: string, cleanup: () => void): void {
    try {
      cleanup();
    } catch (error) {
      this.log('InlineRendererCleanup', new Error(
        `${operation}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  private log(scope: string, error: unknown): void {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    try {
      this.output.appendLine(`[${scope}] ${detail}`);
    } catch {
      // Output failures must never mask a renderer or cleanup failure.
    }
  }
}
