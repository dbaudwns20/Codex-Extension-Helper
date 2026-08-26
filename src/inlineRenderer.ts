import type * as vscode from 'vscode';
import type { ComparisonView } from './coordinator';
import type { ChangeHunk } from './types';
import type { InstalledSpacerPresentation } from './temporaryLineSpacers';
export { DeletedLinesCodeLensProvider } from './deletedLinesCodeLensProvider';

interface InlineRendererApi {
  readonly window: {
    readonly visibleTextEditors: readonly vscode.TextEditor[];
    readonly tabGroups: Pick<vscode.TabGroups, 'all'>;
    createTextEditorDecorationType(options: vscode.DecorationRenderOptions): vscode.TextEditorDecorationType;
  };
  readonly Range: typeof vscode.Range;
  readonly ThemeColor: typeof vscode.ThemeColor;
  readonly DecorationRangeBehavior: typeof vscode.DecorationRangeBehavior;
  readonly OverviewRulerLane: typeof vscode.OverviewRulerLane;
  readonly TabInputText: typeof vscode.TabInputText;
}

interface ViewResources {
  readonly editor: vscode.TextEditor;
}

/** Kept as a compatibility boundary for callers created by older builds. */
export interface InlineRendererSessionState {
  renderingDisabled: boolean;
  warningShown: boolean;
}

export function createInlineRendererSessionState(): InlineRendererSessionState {
  return { renderingDisabled: false, warningShown: false };
}

export interface InsetPlacement {
  anchorLine: number;
  height: number;
}

/** Legacy pure helper retained for consumers; Stable rendering does not use editor insets. */
export function insetPlacementForHunk(hunk: ChangeHunk, modifiedLineCount: number): InsetPlacement {
  const insertionLine = Math.min(
    Math.max(0, hunk.modifiedStart),
    Math.max(0, modifiedLineCount),
  );
  return { anchorLine: insertionLine - 1, height: hunk.originalLines.length };
}

/** Legacy pure helper retained for compatibility with existing consumers. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/** Legacy pure helper retained for compatibility; no webview is created on Stable. */
export function buildDeletedLinesHtml(lines: readonly string[], originalStart: number): string {
  const rows = lines.map((line, index) => {
    const lineNumber = Math.max(0, originalStart) + index + 1;
    return `<div class="line"><span class="gutter">${lineNumber}</span><span class="code">${escapeHtml(line)}</span></div>`;
  }).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><style>html, body { margin: 0; padding: 0; color: var(--vscode-editor-foreground); background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.2)); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }.line { display: flex; min-height: var(--vscode-editor-line-height); white-space: pre; tab-size: var(--vscode-editor-tabSize, 4); }.gutter { min-width: 4ch; padding-right: 1ch; color: var(--vscode-editorLineNumber-foreground); text-align: right; }.code { flex: 1; }</style></head><body>${rows}</body></html>`;
}

export class InlineRenderer implements ComparisonView, vscode.Disposable {
  private readonly addedDecorationType: vscode.TextEditorDecorationType;
  private readonly removedRowDecorationType: vscode.TextEditorDecorationType;
  private readonly removedOverlayDecorationType: vscode.TextEditorDecorationType;
  private readonly resources = new Map<string, ViewResources[]>();
  private disposed = false;

  constructor(
    private readonly api: InlineRendererApi,
    private readonly output: Pick<vscode.OutputChannel, 'appendLine'>,
    private readonly uriKey: (uri: vscode.Uri) => string = (uri) => uri.toString(),
    _sessionState: InlineRendererSessionState = createInlineRendererSessionState(),
  ) {
    this.addedDecorationType = api.window.createTextEditorDecorationType({
      isWholeLine: true,
      rangeBehavior: api.DecorationRangeBehavior.ClosedClosed,
      backgroundColor: new api.ThemeColor('diffEditor.insertedTextBackground'),
      overviewRulerColor: new api.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: api.OverviewRulerLane.Full,
    });
    this.removedRowDecorationType = api.window.createTextEditorDecorationType({
      isWholeLine: true,
      rangeBehavior: api.DecorationRangeBehavior.ClosedClosed,
      backgroundColor: new api.ThemeColor('diffEditor.removedTextBackground'),
      overviewRulerColor: new api.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: api.OverviewRulerLane.Full,
    });
    this.removedOverlayDecorationType = api.window.createTextEditorDecorationType({
      rangeBehavior: api.DecorationRangeBehavior.ClosedClosed,
      overviewRulerColor: new api.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: api.OverviewRulerLane.Full,
    });
  }

  async render(
    key: string,
    hunks: readonly ChangeHunk[],
    presentation?: InstalledSpacerPresentation,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.clear(key);
    const editors = this.api.window.visibleTextEditors.filter(
      (editor) => this.uriKey(editor.document.uri) === key && this.isNormalTextEditor(editor),
    );
    const views: ViewResources[] = [];

    try {
      for (const editor of editors) {
        views.push({ editor });
        editor.setDecorations(this.addedDecorationType, this.greenRanges(hunks, presentation));
        editor.setDecorations(
          this.removedRowDecorationType,
          presentation === undefined ? [] : this.deletedSpacerRows(presentation),
        );
        editor.setDecorations(
          this.removedOverlayDecorationType,
          [],
        );
      }
      if (views.length > 0) {
        this.resources.set(key, views);
      }
    } catch (error) {
      this.log('InlineRenderer', error);
      for (const view of views) {
        this.clearEditor(view.editor);
      }
    }
  }

  hasRendered(key: string): boolean {
    return (this.resources.get(key)?.length ?? 0) > 0;
  }

  clear(key: string): void {
    const views = this.resources.get(key);
    if (views === undefined) {
      return;
    }
    this.resources.delete(key);
    for (const view of views) {
      this.clearEditor(view.editor);
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
    this.cleanup('dispose added decoration type', () => this.addedDecorationType.dispose());
    this.cleanup('dispose removed row decoration type', () => this.removedRowDecorationType.dispose());
    this.cleanup('dispose removed overlay decoration type', () => this.removedOverlayDecorationType.dispose());
  }

  private greenRanges(
    hunks: readonly ChangeHunk[],
    presentation?: InstalledSpacerPresentation,
  ): vscode.Range[] {
    return hunks.flatMap((hunk, hunkIndex) => {
      if (hunk.kind === 'deletion' || hunk.modifiedEnd <= hunk.modifiedStart) {
        return [];
      }
      const mapping = presentation?.plan.hunks[hunkIndex];
      const start = mapping?.modifiedStart ?? hunk.modifiedStart;
      const end = mapping?.modifiedEnd ?? hunk.modifiedEnd;
      return [new this.api.Range(start, 0, end - 1, 0)];
    });
  }

  private deletedSpacerRows(
    presentation: InstalledSpacerPresentation,
  ): vscode.DecorationOptions[] {
    return presentation.plan.hunks.flatMap((mapping) => mapping.removedRows.map((row) => ({
      range: new this.api.Range(row.line, 0, row.line, 0),
      renderOptions: {
        after: {
          contentText: row.text,
          color: new this.api.ThemeColor('editor.foreground'),
          textDecoration: 'none; white-space: pre;',
        },
      },
    })));
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

  private clearEditor(editor: vscode.TextEditor): void {
    this.cleanup('clear added decorations', () => editor.setDecorations(this.addedDecorationType, []));
    this.cleanup('clear removed row decorations', () => editor.setDecorations(this.removedRowDecorationType, []));
    this.cleanup('clear removed overlay decorations', () => editor.setDecorations(this.removedOverlayDecorationType, []));
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
