import * as vscode from 'vscode';
import { ActiveReviewContext } from './activeReviewContext';
import { PerKeyDebouncer } from './changePolicy';
import { ComparisonCoordinator, type ComparisonView } from './coordinator';
import {
  DeletedLinesCodeLensProvider,
  type ReviewCodeLensState,
} from './deletedLinesCodeLensProvider';
import { DiagnosticView } from './diagnosticView';
import { LineDiffEngine } from './diffEngine';
import {
  DocumentChangeFence,
  shouldInvalidateDocumentChange,
  type LiveDocumentSnapshot,
} from './documentChangeFence';
import { constructWithRollback, type DisposableStore } from './disposableStore';
import { isEligibleFile, normalizeSettings, type ExtensionSettings } from './eligibility';
import {
  ExternalChangeDetector,
  normalizeUriKey,
  type ExternalChangeKind,
} from './externalChangeDetector';
import {
  createInlineRendererSessionState,
  InlineRenderer,
  type InlineRendererSessionState,
} from './inlineRenderer';
import { QuickDiffBridge } from './quickDiffBridge';
import {
  ReviewController,
  type LiveReviewDocument,
  type ReviewHost,
} from './reviewController';
import { SnapshotStore } from './snapshotStore';
import type { FileComparisonState, HunkReference } from './types';

const CONFIGURATION_SECTION = 'codexExtensionHelper';
const OUTPUT_CHANNEL_NAME = 'Codex Extension Helper';

interface TestDiagnostics {
  readonly comparisonCount: number;
  readonly renderedComparisonCount: number;
  readonly activeFileHasChanges: boolean;
}

interface TestExtensionApi {
  readonly testDiagnostics: TestDiagnostics;
  simulateExternalChange(
    uri: vscode.Uri,
    baselineText: string,
    currentText: string,
    createdFile?: boolean,
  ): Promise<void>;
}

interface ExternalComparisonCandidate {
  readonly text: string;
  readonly kind: ExternalChangeKind;
}

interface StableReviewHostApi {
  readonly window: Pick<typeof vscode.window, 'activeTextEditor' | 'showErrorMessage'>;
  readonly workspace: Pick<typeof vscode.workspace, 'applyEdit'> & {
    readonly fs: Pick<typeof vscode.workspace.fs, 'delete'>;
  };
  readonly WorkspaceEdit: typeof vscode.WorkspaceEdit;
  readonly Range: typeof vscode.Range;
  readonly Selection: typeof vscode.Selection;
  readonly TextEditorRevealType: typeof vscode.TextEditorRevealType;
}

export interface PendingReviewEditExpectation {
  readonly key: string;
  readonly startingVersion: number;
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly replacementText: string;
  readonly resultingText: string;
}

interface ReviewEditEvent {
  readonly key: string;
  readonly documentVersion: number;
  readonly resultingText: string;
  readonly contentChanges: readonly {
    readonly rangeOffset: number;
    readonly rangeLength: number;
    readonly text: string;
  }[];
}

export class PendingReviewEdits {
  private readonly pending = new Map<string, PendingReviewEditExpectation>();

  begin(expectation: PendingReviewEditExpectation): () => void {
    this.pending.set(expectation.key, expectation);
    let finished = false;
    return () => {
      if (!finished && this.pending.get(expectation.key) === expectation) {
        this.pending.delete(expectation.key);
      }
      finished = true;
    };
  }

  consume(event: ReviewEditEvent): boolean {
    const expectation = this.pending.get(event.key);
    if (expectation === undefined) {
      return false;
    }
    this.pending.delete(event.key);
    if (event.contentChanges.length !== 1) {
      return false;
    }
    const [change] = event.contentChanges;
    return event.documentVersion === expectation.startingVersion + 1
      && event.resultingText === expectation.resultingText
      && change.rangeOffset === expectation.rangeOffset
      && change.rangeLength === expectation.rangeLength
      && change.text === expectation.replacementText;
  }

  clear(): void {
    this.pending.clear();
  }
}

type BeginReviewEdit = (expectation: PendingReviewEditExpectation) => () => void;

function canonicalTextChange(
  originalText: string,
  resultingText: string,
): Pick<PendingReviewEditExpectation, 'rangeOffset' | 'rangeLength' | 'replacementText'> {
  let prefixLength = 0;
  const sharedLength = Math.min(originalText.length, resultingText.length);
  while (
    prefixLength < sharedLength
    && originalText[prefixLength] === resultingText[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < originalText.length - prefixLength
    && suffixLength < resultingText.length - prefixLength
    && originalText[originalText.length - suffixLength - 1]
      === resultingText[resultingText.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  return {
    rangeOffset: prefixLength,
    rangeLength: originalText.length - prefixLength - suffixLength,
    replacementText: resultingText.slice(prefixLength, resultingText.length - suffixLength),
  };
}

type ReviewCommandController = Pick<
  ReviewController,
  'approveHunk' | 'rejectHunk' | 'previousChange' | 'nextChange' | 'approveAll' | 'rejectAll'
>;

type RegisterCommand = (
  command: string,
  callback: (...args: any[]) => unknown,
) => vscode.Disposable;

interface SynchronizedReviewViews {
  readonly renderer: {
    render(key: string, hunks: FileComparisonState['hunks']): Promise<void>;
    clear(key: string): void;
  };
  readonly deletedLines: {
    update(state: ReviewCodeLensState): void;
    clear(key: string): void;
  };
  readonly quickDiff: {
    update(key: string, resource: vscode.Uri, baselineText: string): void;
    clear(key: string, acceptedText?: string): void;
  };
  readonly activeContext: Pick<ActiveReviewContext, 'update'>;
}

interface SynchronizeReviewViewsOptions {
  readonly key: string | undefined;
  readonly state: FileComparisonState | undefined;
  readonly resource: vscode.Uri | undefined;
  readonly activeKey: string | undefined;
  readonly activeState: FileComparisonState | undefined;
  readonly views: SynchronizedReviewViews;
}

const STATE_ONLY_COMPARISON_VIEW: ComparisonView = Object.freeze({
  async render(): Promise<void> {},
  clear(): void {},
  clearAll(): void {},
});

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

export function createReviewHost(
  api: StableReviewHostApi,
  output: Pick<vscode.OutputChannel, 'appendLine'>,
  uriKey: (uri: vscode.Uri) => string = (uri) => uri.toString(),
  beginReviewEdit: BeginReviewEdit = () => () => {},
): ReviewHost {
  const currentEditor = (expected?: LiveReviewDocument): vscode.TextEditor | undefined => {
    const editor = api.window.activeTextEditor;
    if (editor === undefined) {
      return undefined;
    }
    if (
      expected !== undefined
      && (
        uriKey(editor.document.uri) !== expected.key
        || editor.document.version !== expected.version
        || editor.document.getText() !== expected.text
      )
    ) {
      return undefined;
    }
    return editor;
  };

  const applyReplacement = async (
    document: LiveReviewDocument,
    startOffset: number,
    endOffset: number,
    replacementText: string,
  ): Promise<boolean> => {
    const editor = currentEditor(document);
    if (editor === undefined) {
      return false;
    }
    const edit = new api.WorkspaceEdit();
    edit.replace(
      editor.document.uri,
      new api.Range(
        editor.document.positionAt(startOffset),
        editor.document.positionAt(endOffset),
      ),
      replacementText,
    );
    const resultingText = document.text.slice(0, startOffset)
      + replacementText
      + document.text.slice(endOffset);
    const finishReviewEdit = beginReviewEdit({
      key: document.key,
      startingVersion: document.version,
      ...canonicalTextChange(document.text, resultingText),
      resultingText,
    });
    try {
      return await api.workspace.applyEdit(edit);
    } finally {
      finishReviewEdit();
    }
  };

  return {
    activeDocument(): LiveReviewDocument | undefined {
      const editor = currentEditor();
      if (editor === undefined) {
        return undefined;
      }
      const { document } = editor;
      return {
        uri: document.uri,
        key: uriKey(document.uri),
        text: document.getText(),
        version: document.version,
        cursorLine: editor.selection.active.line,
        lineCount: document.lineCount,
        eol: document.eol,
      };
    },
    applyReplacement(document, replacement): Promise<boolean> {
      return applyReplacement(
        document,
        replacement.startOffset,
        replacement.endOffset,
        replacement.replacementText,
      );
    },
    replaceAll(document, text): Promise<boolean> {
      return applyReplacement(document, 0, document.text.length, text);
    },
    async deleteToTrash(uri): Promise<void> {
      await api.workspace.fs.delete(uri, { useTrash: true });
    },
    reveal(document, line): void {
      const editor = currentEditor(document);
      if (editor === undefined) {
        return;
      }
      const range = new api.Range(line, 0, line, 0);
      editor.selection = new api.Selection(range.start, range.start);
      editor.revealRange(range, api.TextEditorRevealType.InCenter);
    },
    showError(message): void {
      void Promise.resolve(api.window.showErrorMessage(message)).catch((error) => {
        try {
          output.appendLine(`[Review message] ${errorDetail(error)}`);
        } catch {
          // Reporting must not leak a rejected promise into VS Code's event loop.
        }
      });
    },
    log(scope, error): void {
      try {
        output.appendLine(`[${scope}] ${errorDetail(error)}`);
      } catch {
        // Logging failures must not escape command callbacks.
      }
    },
  };
}

export function registerReviewCommands(
  ownership: DisposableStore,
  registerCommand: RegisterCommand,
  controller: ReviewCommandController,
  onError: (scope: string, error: unknown) => void = () => undefined,
): void {
  const guarded = (
    scope: string,
    operation: (...args: any[]) => void | PromiseLike<void>,
  ): ((...args: any[]) => Promise<void>) => async (...args): Promise<void> => {
    try {
      await operation(...args);
    } catch (error) {
      try {
        onError(scope, error);
      } catch {
        // Error reporting must not reject a command callback.
      }
    }
  };

  ownership.use(registerCommand(
    'codexExtensionHelper.approveHunk',
    guarded('ApproveHunkCommand', (reference: HunkReference) => controller.approveHunk(reference)),
  ));
  ownership.use(registerCommand(
    'codexExtensionHelper.rejectHunk',
    guarded('RejectHunkCommand', (reference: HunkReference) => controller.rejectHunk(reference)),
  ));
  ownership.use(registerCommand(
    'codexExtensionHelper.previousChange',
    guarded('PreviousChangeCommand', (uri?: vscode.Uri) => controller.previousChange(uri)),
  ));
  ownership.use(registerCommand(
    'codexExtensionHelper.nextChange',
    guarded('NextChangeCommand', (uri?: vscode.Uri) => controller.nextChange(uri)),
  ));
  ownership.use(registerCommand(
    'codexExtensionHelper.approveAll',
    guarded('ApproveAllCommand', (uri?: vscode.Uri) => controller.approveAll(uri)),
  ));
  ownership.use(registerCommand(
    'codexExtensionHelper.rejectAll',
    guarded('RejectAllCommand', (uri?: vscode.Uri) => controller.rejectAll(uri)),
  ));
}

export async function synchronizeReviewViews({
  key,
  state,
  resource,
  activeKey,
  activeState,
  views,
}: SynchronizeReviewViewsOptions): Promise<void> {
  const pending: PromiseLike<void>[] = [];
  if (key !== undefined) {
    if (state !== undefined && state.hunks.length > 0) {
      pending.push(views.renderer.render(key, state.hunks));
      views.deletedLines.update({
        key,
        sourceRevision: state.sourceRevision,
        currentText: state.currentText,
        hunks: state.hunks,
      });
      if (resource === undefined) {
        views.quickDiff.clear(key);
      } else {
        views.quickDiff.update(key, resource, state.baselineText);
      }
    } else {
      views.renderer.clear(key);
      views.deletedLines.clear(key);
      views.quickDiff.clear(key, state?.currentText);
    }
  }
  pending.push(views.activeContext.update(activeKey, activeState));
  await Promise.all(pending);
}

function sameStrings(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function readSettings(): ExtensionSettings {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const enabled = configuration.get<unknown>('enabled');
  const debounceMs = configuration.get<unknown>('debounceMs');
  const maxFileSizeKb = configuration.get<unknown>('maxFileSizeKb');
  const exclude = configuration.get<unknown>('exclude');

  return normalizeSettings({
    enabled: typeof enabled === 'boolean' ? enabled : undefined,
    debounceMs: typeof debounceMs === 'number' ? debounceMs : undefined,
    maxFileSizeBytes: typeof maxFileSizeKb === 'number' ? maxFileSizeKb * 1024 : undefined,
    exclude: Array.isArray(exclude) ? exclude.filter((value): value is string => typeof value === 'string') : undefined,
  });
}

export class ExtensionRuntime implements vscode.Disposable {
  private readonly snapshots: SnapshotStore;
  private readonly view: DiagnosticView;
  private readonly coordinator: ComparisonCoordinator;
  private readonly quickDiff: QuickDiffBridge;
  private readonly deletedLines: DeletedLinesCodeLensProvider;
  private readonly activeReviewContext: ActiveReviewContext;
  private readonly detector: ExternalChangeDetector;
  private readonly documentDebouncer: PerKeyDebouncer<string>;
  private readonly ownership: DisposableStore;
  private readonly trackedUris = new Map<string, vscode.Uri>();
  private readonly comparisonKeys = new Set<string>();
  private readonly documentFence = new DocumentChangeFence();
  private readonly externalCandidates = new Map<string, ExternalComparisonCandidate>();
  private readonly pendingReviewEdits = new PendingReviewEdits();
  private visibleKeys = new Set<string>();
  private disposed = false;

  constructor(
    private settingsValue: ExtensionSettings,
    private readonly output: vscode.OutputChannel,
    rendererSessionState: InlineRendererSessionState,
  ) {
    const construction = constructWithRollback((ownership) => {
      const snapshots = new SnapshotStore();
      const activeReviewContext = ownership.use(new ActiveReviewContext(
        (key, value) => vscode.commands.executeCommand('setContext', key, value),
      ));
      const quickDiff = ownership.use(new QuickDiffBridge());
      const deletedLines = ownership.use(new DeletedLinesCodeLensProvider(vscode, normalizeUriKey));
      const renderer = ownership.use(new InlineRenderer(
        vscode,
        output,
        normalizeUriKey,
        rendererSessionState,
      ));
      const view = new DiagnosticView(renderer);
      const coordinator = ownership.use(new ComparisonCoordinator(
        new LineDiffEngine(),
        snapshots,
        STATE_ONLY_COMPARISON_VIEW,
      ));
      const reviewController = ownership.use(new ReviewController(
        coordinator,
        createReviewHost(
          vscode,
          output,
          normalizeUriKey,
          (expectation) => this.pendingReviewEdits.begin(expectation),
        ),
        (key) => this.syncComparison(key),
      ));
      registerReviewCommands(
        ownership,
        (command, callback) => vscode.commands.registerCommand(command, callback),
        reviewController,
        (scope, error) => this.log(scope, error),
      );
      const detector = ownership.use(new ExternalChangeDetector({
        readFile: (uri) => vscode.workspace.fs.readFile(uri as vscode.Uri),
        settings: () => this.settingsValue,
        relativePath: (uri) => this.relativePath(uri as vscode.Uri),
        onComparison: async (key, text, kind) => {
          await this.applyExternalComparison(key, text, kind);
        },
        onDelete: (key) => this.deleteKey(key, false),
        onError: (error) => this.log('ExternalChangeDetector', error),
      }));
      const documentDebouncer = ownership.use(new PerKeyDebouncer<string>());
      const watcher = ownership.use(vscode.workspace.createFileSystemWatcher('**/*'));
      ownership.use(watcher.onDidCreate((uri) => this.guard('FileCreate', () => this.handleWatcherEvent(uri, 'create'))));
      ownership.use(watcher.onDidChange((uri) => this.guard('FileChange', () => this.handleWatcherEvent(uri, 'change'))));
      ownership.use(watcher.onDidDelete((uri) => this.guard('FileDelete', () => this.handleWatcherDelete(uri))));
      ownership.use(vscode.workspace.onDidOpenTextDocument((document) => this.guard('DocumentOpen', () => this.seedDocument(document))));
      ownership.use(vscode.workspace.onDidChangeTextDocument((event) => this.guard('DocumentChange', () => this.handleDocumentChange(event))));
      ownership.use(vscode.workspace.onWillSaveTextDocument((event) => this.guard('DocumentWillSave', () => this.handleWillSave(event))));
      ownership.use(vscode.workspace.onDidSaveTextDocument((document) => this.guard('DocumentSave', () => this.handleDidSave(document))));
      ownership.use(vscode.workspace.onDidCloseTextDocument((document) => this.guard('DocumentClose', () => this.handleDocumentClose(document))));
      ownership.use(vscode.window.onDidChangeVisibleTextEditors((editors) => this.guard('VisibleEditors', () => this.handleVisibleEditors(editors))));
      ownership.use(vscode.window.onDidChangeActiveTextEditor((editor) => this.guard('ActiveEditor', () => this.handleActiveEditor(editor))));
      ownership.use(vscode.workspace.onDidChangeWorkspaceFolders((event) => this.guard('WorkspaceFolders', () => this.handleWorkspaceFolders(event))));

      return {
        snapshots,
        view,
        coordinator,
        detector,
        documentDebouncer,
        quickDiff,
        deletedLines,
        activeReviewContext,
      };
    }, (error) => output.appendLine(`[ConstructionRollback] ${errorDetail(error)}`));

    this.ownership = construction.resources;
    this.snapshots = construction.value.snapshots;
    this.view = construction.value.view;
    this.coordinator = construction.value.coordinator;
    this.quickDiff = construction.value.quickDiff;
    this.deletedLines = construction.value.deletedLines;
    this.activeReviewContext = construction.value.activeReviewContext;
    this.detector = construction.value.detector;
    this.documentDebouncer = construction.value.documentDebouncer;

    try {
      for (const document of vscode.workspace.textDocuments) {
        this.guard('InitialDocument', () => this.seedDocument(document));
      }
      this.guard('InitialEditors', () => this.handleVisibleEditors(vscode.window.visibleTextEditors));
      this.guard('InitialActiveEditor', () => this.handleActiveEditor(vscode.window.activeTextEditor));
    } catch (error) {
      this.ownership.dispose();
      throw error;
    }
  }

  get comparisonCount(): number {
    return this.comparisonKeys.size;
  }

  get renderedComparisonCount(): number {
    return this.view.renderedComparisonCount;
  }

  get activeFileHasChanges(): boolean {
    return this.activeReviewContext.activeFileHasChanges;
  }

  async simulateExternalChange(
    uri: vscode.Uri,
    baselineText: string,
    currentText: string,
    createdFile = false,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }

    const key = normalizeUriKey(uri);
    this.externalCandidates.delete(key);
    this.documentFence.invalidate(key);
    this.documentDebouncer.cancel(key);
    this.detector.markRecentSave(uri);
    this.trackedUris.set(key, uri);
    this.coordinator.seed(key, baselineText);
    if (createdFile) {
      await this.coordinator.externalCreate(key, currentText);
    } else {
      await this.coordinator.externalChange(key, currentText);
    }
    this.syncComparison(key);
  }

  async openActiveDiff(): Promise<void> {
    const resource = vscode.window.activeTextEditor?.document.uri;
    if (resource === undefined || !await this.quickDiff.openDiff(resource)) {
      void vscode.window.showInformationMessage('No active Codex comparison for this file.');
    }
  }

  updateSettings(settings: ExtensionSettings): void {
    this.settingsValue = settings;
    for (const [key, uri] of [...this.trackedUris]) {
      const state = this.snapshots.get(key);
      if (state !== undefined && !this.isEligible(uri, state.currentText)) {
        this.deleteKey(key);
      }
    }
    for (const document of vscode.workspace.textDocuments) {
      this.seedDocument(document);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    for (const key of [...this.trackedUris.keys()]) {
      this.deleteKey(key);
    }
    this.syncPresentation();
    this.disposed = true;
    this.ownership.dispose();
    this.trackedUris.clear();
    this.comparisonKeys.clear();
    this.visibleKeys.clear();
    this.externalCandidates.clear();
    this.pendingReviewEdits.clear();
    this.documentFence.clear();
  }

  private handleWatcherEvent(uri: vscode.Uri, kind: 'create' | 'change'): void {
    if (this.disposed || !this.preflightEligible(uri)) {
      return;
    }

    const key = normalizeUriKey(uri);
    this.externalCandidates.delete(key);
    this.trackedUris.set(key, uri);
    if (kind === 'create') {
      this.detector.handleCreate(uri);
    } else {
      this.detector.handleChange(uri);
    }
  }

  private handleWatcherDelete(uri: vscode.Uri): void {
    if (!this.disposed) {
      this.detector.handleDelete(uri);
    }
  }

  private seedDocument(document: vscode.TextDocument): void {
    const text = document.getText();
    if (this.disposed || !this.isEligible(document.uri, text)) {
      return;
    }

    const key = normalizeUriKey(document.uri);
    this.trackedUris.set(key, document.uri);
    if (this.snapshots.get(key) === undefined) {
      this.coordinator.seed(key, text);
      this.syncComparison(key);
    }
  }

  private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    if (this.disposed || event.contentChanges.length === 0) {
      return;
    }

    const key = normalizeUriKey(event.document.uri);
    const isReviewEdit = this.pendingReviewEdits.consume({
      key,
      documentVersion: event.document.version,
      resultingText: event.document.getText(),
      contentChanges: event.contentChanges.map((change) => ({
        rangeOffset: change.rangeOffset,
        rangeLength: change.rangeLength,
        text: change.text,
      })),
    });
    if (
      !isReviewEdit
      && !shouldInvalidateDocumentChange(event.contentChanges.length, event.document.isDirty)
    ) {
      const candidate = this.externalCandidates.get(key);
      if (candidate !== undefined && candidate.text === event.document.getText()) {
        void this.run(
          'ExternalDocumentRefresh',
          () => this.tryApplyExternalComparison(key, candidate),
        );
      }
      return;
    }

    this.externalCandidates.delete(key);
    this.documentFence.invalidate(key);
    this.detector.invalidate(key);
    this.coordinator.invalidate(key);
    this.documentDebouncer.cancel(key);
    const state = this.snapshots.get(key);
    if (state === undefined || !state.comparisonActive) {
      return;
    }
    if (!this.isEligible(event.document.uri, event.document.getText())) {
      this.deleteKey(key);
      return;
    }

    this.documentDebouncer.schedule(key, this.settingsValue.debounceMs, () => {
      void this.run('DocumentEdit', async () => {
        const text = event.document.getText();
        const isCurrent = this.createDocumentGuard(key, text);
        if (isCurrent === undefined) {
          return;
        }
        await this.coordinator.documentEdit(key, text, isCurrent);
        this.syncComparison(key);
      });
    });
  }

  private handleWillSave(event: vscode.TextDocumentWillSaveEvent): void {
    if (!this.disposed && this.isEligible(event.document.uri, event.document.getText())) {
      const key = normalizeUriKey(event.document.uri);
      this.externalCandidates.delete(key);
      this.documentFence.invalidate(key);
      this.documentDebouncer.cancel(key);
      this.coordinator.invalidate(key);
      this.detector.markRecentSave(event.document.uri);
    }
  }

  private handleDidSave(document: vscode.TextDocument): void {
    if (this.disposed) {
      return;
    }

    const key = normalizeUriKey(document.uri);
    this.externalCandidates.delete(key);
    this.documentFence.invalidate(key);
    this.detector.invalidate(key);
    this.documentDebouncer.cancel(key);
    const text = document.getText();
    if (!this.isEligible(document.uri, text)) {
      this.deleteKey(key);
      return;
    }

    this.trackedUris.set(key, document.uri);
    this.coordinator.save(key, text);
    this.syncComparison(key);
  }

  private handleDocumentClose(document: vscode.TextDocument): void {
    if (this.disposed) {
      return;
    }

    const key = normalizeUriKey(document.uri);
    this.documentDebouncer.cancel(key);
    if (!vscode.window.visibleTextEditors.some(
      (editor) => normalizeUriKey(editor.document.uri) === key,
    )) {
      this.syncComparison(key);
    }
  }

  private handleVisibleEditors(editors: readonly vscode.TextEditor[]): void {
    if (this.disposed) {
      return;
    }

    const nextVisible = new Set<string>();
    for (const editor of editors) {
      const text = editor.document.getText();
      if (!this.isEligible(editor.document.uri, text)) {
        continue;
      }

      const key = normalizeUriKey(editor.document.uri);
      nextVisible.add(key);
      this.trackedUris.set(key, editor.document.uri);
      if (this.snapshots.get(key) === undefined) {
        this.coordinator.seed(key, text);
      }
    }

    const affectedKeys = new Set([...this.visibleKeys, ...nextVisible]);
    this.visibleKeys = nextVisible;

    for (const key of affectedKeys) {
      this.syncComparison(key);
    }
  }

  private handleActiveEditor(editor: vscode.TextEditor | undefined): void {
    if (this.disposed) {
      return;
    }

    if (editor === undefined || !this.isEligible(editor.document.uri, editor.document.getText())) {
      this.syncPresentation();
      return;
    }

    this.seedDocument(editor.document);
    this.syncComparison(normalizeUriKey(editor.document.uri));
  }

  private handleWorkspaceFolders(event: vscode.WorkspaceFoldersChangeEvent): void {
    if (this.disposed) {
      return;
    }

    for (const [key, uri] of [...this.trackedUris]) {
      if (event.removed.some((folder) => this.isWithin(uri, folder.uri))) {
        this.deleteKey(key);
      }
    }
    for (const document of vscode.workspace.textDocuments) {
      this.seedDocument(document);
    }
  }

  private deleteKey(key: string, invalidateDetector = true): void {
    this.externalCandidates.delete(key);
    this.documentFence.invalidate(key);
    if (invalidateDetector) {
      this.detector.invalidate(key);
    }
    this.documentDebouncer.cancel(key);
    this.coordinator.delete(key);
    this.syncComparison(key);
    this.trackedUris.delete(key);
  }

  private syncComparison(key: string): void {
    const state = this.snapshots.get(key);
    if (state !== undefined && state.hunks.length > 0) {
      this.comparisonKeys.add(key);
    } else {
      this.comparisonKeys.delete(key);
    }

    this.syncPresentation(key);
  }

  private syncPresentation(key?: string): void {
    const state = key === undefined ? undefined : this.snapshots.get(key);
    const activeDocument = vscode.window.activeTextEditor?.document;
    const activeKey = activeDocument?.uri.scheme === 'file'
      ? normalizeUriKey(activeDocument.uri)
      : undefined;
    const activeState = activeKey === undefined
      ? undefined
      : this.snapshots.get(activeKey);
    void this.run('SynchronizeComparison', () => synchronizeReviewViews({
      key,
      state,
      resource: key === undefined ? undefined : this.trackedUris.get(key),
      activeKey,
      activeState,
      views: {
        renderer: this.view,
        deletedLines: this.deletedLines,
        quickDiff: this.quickDiff,
        activeContext: this.activeReviewContext,
      },
    }));
  }

  private async applyExternalComparison(
    key: string,
    text: string,
    kind: ExternalChangeKind,
  ): Promise<void> {
    const candidate = { text, kind };
    this.externalCandidates.set(key, candidate);
    await this.tryApplyExternalComparison(key, candidate);
  }

  private async tryApplyExternalComparison(
    key: string,
    candidate: ExternalComparisonCandidate,
  ): Promise<void> {
    if (this.disposed || this.externalCandidates.get(key) !== candidate) {
      return;
    }

    const document = this.liveDocument(key);
    if (document !== undefined && document.getText() !== candidate.text) {
      if (document.isDirty && this.externalCandidates.get(key) === candidate) {
        this.externalCandidates.delete(key);
      }
      return;
    }

    const isCurrent = this.createDocumentGuard(key, candidate.text);
    if (isCurrent === undefined) {
      return;
    }

    if (candidate.kind === 'create') {
      await this.coordinator.externalCreate(key, candidate.text, isCurrent);
    } else {
      await this.coordinator.externalChange(key, candidate.text, isCurrent);
    }
    if (this.externalCandidates.get(key) === candidate) {
      this.externalCandidates.delete(key);
    }
    this.syncComparison(key);
  }

  private createDocumentGuard(
    key: string,
    expectedText: string,
  ): (() => boolean) | undefined {
    const document = this.liveDocument(key);
    const snapshot = document === undefined ? undefined : this.documentSnapshot(document);
    const token = this.documentFence.capture(key, expectedText, snapshot);
    if (!this.documentFence.isCurrent(token, snapshot)) {
      return undefined;
    }

    return () => {
      const current = this.liveDocument(key);
      return this.documentFence.isCurrent(
        token,
        current === undefined ? undefined : this.documentSnapshot(current),
      );
    };
  }

  private liveDocument(key: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(
      (document) => normalizeUriKey(document.uri) === key,
    );
  }

  private liveDocumentMatches(key: string, expectedText: string): boolean {
    const document = this.liveDocument(key);
    return document === undefined || document.getText() === expectedText;
  }

  private documentSnapshot(document: vscode.TextDocument): LiveDocumentSnapshot {
    return {
      version: document.version,
      text: document.getText(),
      isDirty: document.isDirty,
    };
  }

  private preflightEligible(uri: vscode.Uri): boolean {
    return vscode.workspace.getWorkspaceFolder(uri) !== undefined && isEligibleFile({
      scheme: uri.scheme,
      relativePath: this.relativePath(uri),
      text: '',
      sizeBytes: 0,
    }, this.settingsValue);
  }

  private isEligible(uri: vscode.Uri, text: string): boolean {
    return vscode.workspace.getWorkspaceFolder(uri) !== undefined && isEligibleFile({
      scheme: uri.scheme,
      relativePath: this.relativePath(uri),
      text,
      sizeBytes: Buffer.byteLength(text, 'utf8'),
    }, this.settingsValue);
  }

  private relativePath(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  }

  private isWithin(uri: vscode.Uri, folder: vscode.Uri): boolean {
    if (uri.scheme !== folder.scheme || uri.authority !== folder.authority) {
      return false;
    }
    const folderPath = folder.path.endsWith('/') ? folder.path : `${folder.path}/`;
    return uri.path === folder.path || uri.path.startsWith(folderPath);
  }

  private async run(scope: string, operation: () => void | PromiseLike<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.log(scope, error);
    }
  }

  private guard(scope: string, operation: () => void): void {
    try {
      operation();
    } catch (error) {
      this.log(scope, error);
    }
  }

  private log(scope: string, error: unknown): void {
    this.output.appendLine(`[${scope}] ${errorDetail(error)}`);
  }
}

export class ExtensionController implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly rendererSessionState = createInlineRendererSessionState();
  private runtime: ExtensionRuntime | undefined;
  private settings = normalizeSettings({ enabled: false });
  private disposed = false;

  constructor(private output: vscode.OutputChannel | undefined) {}

  get comparisonCount(): number {
    return this.runtime?.comparisonCount ?? 0;
  }

  get renderedComparisonCount(): number {
    return this.runtime?.renderedComparisonCount ?? 0;
  }

  get activeFileHasChanges(): boolean {
    return this.runtime?.activeFileHasChanges ?? false;
  }

  async simulateExternalChange(
    uri: vscode.Uri,
    baselineText: string,
    currentText: string,
    createdFile = false,
  ): Promise<void> {
    await this.runtime?.simulateExternalChange(uri, baselineText, currentText, createdFile);
  }

  async openActiveDiff(): Promise<void> {
    if (this.runtime === undefined) {
      void vscode.window.showInformationMessage('Codex Extension Helper is disabled.');
      return;
    }
    await this.runtime.openActiveDiff();
  }

  start(): void {
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIGURATION_SECTION)) {
        this.refreshConfiguration();
      }
    }));
    this.refreshConfiguration();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0).reverse()) {
      subscription.dispose();
    }
    this.runtime?.dispose();
    this.runtime = undefined;
    this.output?.dispose();
    this.output = undefined;
  }

  private refreshConfiguration(): void {
    if (this.disposed) {
      return;
    }

    try {
      const next = readSettings();
      const enabledChanged = next.enabled !== this.settings.enabled;
      const excludeChanged = !sameStrings(next.exclude, this.settings.exclude);
      this.settings = next;

      if (!next.enabled) {
        this.runtime?.dispose();
        this.runtime = undefined;
        this.output?.dispose();
        this.output = undefined;
        return;
      }

      this.output ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
      if (this.runtime === undefined || enabledChanged || excludeChanged) {
        this.runtime?.dispose();
        this.runtime = undefined;
        this.runtime = new ExtensionRuntime(next, this.output, this.rendererSessionState);
      } else {
        this.runtime.updateSettings(next);
      }
    } catch (error) {
      this.output ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
      this.output.appendLine(`[Configuration] ${errorDetail(error)}`);
    }
  }
}

let activeController: ExtensionController | undefined;

export const testDiagnostics: TestDiagnostics = Object.freeze({
  get comparisonCount(): number {
    return activeController?.comparisonCount ?? 0;
  },
  get renderedComparisonCount(): number {
    return activeController?.renderedComparisonCount ?? 0;
  },
  get activeFileHasChanges(): boolean {
    return activeController?.activeFileHasChanges ?? false;
  },
});

export function activate(context: vscode.ExtensionContext): TestExtensionApi | undefined {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const controller = new ExtensionController(output);
  activeController = controller;
  context.subscriptions.push(controller);
  context.subscriptions.push(vscode.commands.registerCommand(
    'codexExtensionHelper.openDiff',
    () => controller.openActiveDiff(),
  ));
  controller.start();

  return process.env.CODEX_EXTENSION_HELPER_TEST === '1'
    ? {
      testDiagnostics,
      simulateExternalChange: (uri, baselineText, currentText, createdFile) => (
        controller.simulateExternalChange(uri, baselineText, currentText, createdFile)
      ),
    }
    : undefined;
}

export function deactivate(): void {
  activeController?.dispose();
  activeController = undefined;
}
