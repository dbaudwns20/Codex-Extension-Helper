import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ActiveReviewContext } from './activeReviewContext';
import { PerKeyDebouncer } from './changePolicy';
import { ComparisonCoordinator, type ComparisonView } from './coordinator';
import {
  formatExplorerResourcesAsMentions,
  insertMentionsIntoCodex,
  type ExplorerMentionResource,
} from './codexChatInsert';
import { createCodexDropPatchController, registerCodexDropPatchCommands } from './codexDropPatchCommands';
import { createCodexDropPatchRuntimeDependencies } from './codexDropPatchRuntime';
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
import { GitChangeGuard } from './gitChangeGuard';
import { DisplayEditFence } from './displayEditFence';
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
import {
  TemporaryLineSpacerManager,
  type InstalledSpacerPresentation,
  type SpacerDocument,
} from './temporaryLineSpacers';
import type {
  ExactCodexProvenance,
  FileComparisonState,
  FileLifecycle,
  HunkReference,
} from './types';

const CONFIGURATION_SECTION = 'codexExtensionHelper';
const OUTPUT_CHANNEL_NAME = 'Codex Extension Helper';
const CODEX_CHAT_FOCUS_DELAY_MS = 350;
const MACOS_MENTION_PASTE_SCRIPT = [
  'tell application "System Events"',
  'keystroke "v" using command down',
  'end tell',
].join('\n');

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
    lifecycle?: FileLifecycle,
  ): Promise<void>;
}

interface ExternalComparisonCandidate {
  readonly text: string;
  readonly kind: ExternalChangeKind;
}

interface StableReviewHostApi {
  readonly window: Pick<typeof vscode.window, 'activeTextEditor' | 'showErrorMessage'>;
  readonly workspace: Pick<
    typeof vscode.workspace,
    'applyEdit' | 'openTextDocument' | 'textDocuments'
  > & {
    readonly fs: Pick<typeof vscode.workspace.fs, 'delete' | 'stat' | 'writeFile' | 'rename'>;
  };
  readonly WorkspaceEdit: typeof vscode.WorkspaceEdit;
  readonly Range: typeof vscode.Range;
  readonly Selection: typeof vscode.Selection;
  readonly TextEditorRevealType: typeof vscode.TextEditorRevealType;
}

export interface PendingReviewEditExpectation {
  readonly key: string;
  readonly startingVersion: number;
  readonly originalText: string;
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
    return event.documentVersion === expectation.startingVersion + 1
      && event.resultingText === expectation.resultingText
      && applyContentChanges(expectation.originalText, event.contentChanges)
        === expectation.resultingText;
  }

  clear(): void {
    this.pending.clear();
  }
}

type BeginReviewEdit = (expectation: PendingReviewEditExpectation) => () => void;

function applyContentChanges(
  originalText: string,
  contentChanges: ReviewEditEvent['contentChanges'],
): string | undefined {
  if (contentChanges.length === 0) {
    return undefined;
  }

  const ordered = [...contentChanges].sort((left, right) => (
    left.rangeOffset - right.rangeOffset
  ));
  let previousOffset = -1;
  let previousEnd = 0;
  for (const change of ordered) {
    if (
      !Number.isSafeInteger(change.rangeOffset)
      || !Number.isSafeInteger(change.rangeLength)
      || change.rangeOffset < 0
      || change.rangeLength < 0
      || change.rangeOffset + change.rangeLength > originalText.length
      || change.rangeOffset < previousEnd
      || change.rangeOffset === previousOffset
    ) {
      return undefined;
    }
    previousOffset = change.rangeOffset;
    previousEnd = change.rangeOffset + change.rangeLength;
  }

  let result = originalText;
  for (const change of ordered.reverse()) {
    result = result.slice(0, change.rangeOffset)
      + change.text
      + result.slice(change.rangeOffset + change.rangeLength);
  }
  return result;
}

type ReviewCommandController = Pick<
  ReviewController,
  | 'approveHunk'
  | 'rejectHunk'
  | 'previousChange'
  | 'nextChange'
  | 'approveAll'
  | 'rejectAll'
  | 'approveFile'
  | 'rejectFile'
  | 'approveAllFiles'
  | 'rejectAllFiles'
>;

type RegisterCommand = (
  command: string,
  callback: (...args: any[]) => unknown,
) => vscode.Disposable;

interface SynchronizedReviewViews {
  readonly renderer: {
    render(
      key: string,
      hunks: FileComparisonState['hunks'],
      presentation?: InstalledSpacerPresentation,
    ): Promise<void>;
    clear(key: string): void;
  };
  readonly deletedLines: {
    update(state: ReviewCodeLensState): void;
    clear(key: string): void;
  };
  readonly quickDiff: {
    update(
      key: string,
      resource: vscode.Uri,
      baselineText: string,
      lifecycle?: FileLifecycle,
    ): void;
    clear(key: string, acceptedText?: string): void;
  };
  readonly activeContext: Pick<ActiveReviewContext, 'update'>;
  readonly spacers?: Pick<TemporaryLineSpacerManager, 'install' | 'presentation' | 'clear'>;
}

interface SynchronizeReviewViewsOptions {
  readonly key: string | undefined;
  readonly state: FileComparisonState | undefined;
  readonly resource: vscode.Uri | undefined;
  readonly activeKey: string | undefined;
  readonly activeState: FileComparisonState | undefined;
  readonly views: SynchronizedReviewViews;
  readonly isCurrent?: () => boolean;
}

const STATE_ONLY_COMPARISON_VIEW: ComparisonView = Object.freeze({
  async render(): Promise<void> {},
  clear(): void {},
  clearAll(): void {},
});

const SIMULATED_EXACT_PROVENANCE: ExactCodexProvenance = Object.freeze({
  confidence: 'exact',
  threadId: 'extension-test',
  turnId: 'simulated-change',
  itemIds: Object.freeze(['simulated-file-change']),
});

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

export function createReviewHost(
  api: StableReviewHostApi,
  output: Pick<vscode.OutputChannel, 'appendLine'>,
  uriKey: (uri: vscode.Uri) => string = (uri) => uri.toString(),
  beginReviewEdit: BeginReviewEdit = () => () => {},
  displayLine: (key: string, canonicalLine: number) => number = (_key, line) => line,
): ReviewHost {
  const reviewDocument = (
    document: vscode.TextDocument,
    cursorLine: number,
  ): LiveReviewDocument => ({
    uri: document.uri,
    key: uriKey(document.uri),
    text: document.getText(),
    version: document.version,
    cursorLine,
    lineCount: document.lineCount,
    eol: document.eol,
  });
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
    const liveDocument = currentEditor(document)?.document
      ?? api.workspace.textDocuments.find((candidate) => (
        uriKey(candidate.uri) === document.key
        && candidate.version === document.version
        && candidate.getText() === document.text
      ));
    if (liveDocument === undefined) {
      return false;
    }
    const edit = new api.WorkspaceEdit();
    edit.replace(
      liveDocument.uri,
      new api.Range(
        liveDocument.positionAt(startOffset),
        liveDocument.positionAt(endOffset),
      ),
      replacementText,
    );
    const resultingText = document.text.slice(0, startOffset)
      + replacementText
      + document.text.slice(endOffset);
    const finishReviewEdit = beginReviewEdit({
      key: document.key,
      startingVersion: document.version,
      originalText: document.text,
      resultingText,
    });
    try {
      return await api.workspace.applyEdit(edit);
    } finally {
      finishReviewEdit();
    }
  };
  const isFileNotFound = (error: unknown): boolean => (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'FileNotFound'
  );
  const isFileAbsent = async (uri: vscode.Uri): Promise<boolean> => {
    try {
      await api.workspace.fs.stat(uri);
      return false;
    } catch (error) {
      if (isFileNotFound(error)) {
        return true;
      }
      throw error;
    }
  };

  return {
    activeDocument(): LiveReviewDocument | undefined {
      const editor = currentEditor();
      if (editor === undefined) {
        return undefined;
      }
      return reviewDocument(editor.document, editor.selection.active.line);
    },
    async reviewDocument(uri): Promise<LiveReviewDocument | undefined> {
      const document = await api.workspace.openTextDocument(uri);
      return reviewDocument(document, 0);
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
    isFileAbsent(uri): Promise<boolean> {
      return isFileAbsent(uri);
    },
    async restoreDeletedFile(uri, text): Promise<boolean> {
      if (!await isFileAbsent(uri)) {
        return false;
      }
      const temporary = uri.with({
        path: `${uri.path}.codex-restore-${randomUUID()}`,
        query: '',
        fragment: '',
      });
      let writeCompleted = false;
      try {
        await api.workspace.fs.writeFile(temporary, new TextEncoder().encode(text));
        writeCompleted = true;
        await api.workspace.fs.rename(temporary, uri, { overwrite: false });
        return true;
      } catch (error) {
        try {
          await api.workspace.fs.delete(temporary);
        } catch (cleanupError) {
          if (!isFileNotFound(cleanupError)) {
            try {
              output.appendLine(`[Restore deleted file cleanup] ${errorDetail(cleanupError)}`);
            } catch {
              // Cleanup reporting must not hide the original restore result.
            }
          }
        }
        if (writeCompleted && !await isFileAbsent(uri)) {
          return false;
        }
        throw error;
      }
    },
    reveal(document, line): void {
      const editor = currentEditor(document);
      if (editor === undefined) {
        return;
      }
      const mappedLine = Math.min(
        Math.max(0, displayLine(document.key, line)),
        Math.max(0, editor.document.lineCount - 1),
      );
      const range = new api.Range(mappedLine, 0, mappedLine, 0);
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
  type ResourceCommandArgument =
    | vscode.Uri
    | vscode.SourceControlResourceState
    | readonly vscode.SourceControlResourceState[];
  const resourceUris = (value: ResourceCommandArgument): readonly vscode.Uri[] => {
    if (Array.isArray(value)) {
      return (value as readonly vscode.SourceControlResourceState[])
        .map((state) => state.resourceUri);
    }
    const single = value as vscode.Uri | vscode.SourceControlResourceState;
    return 'resourceUri' in single ? [single.resourceUri] : [single];
  };
  const runResourceCommand = async (
    scope: string,
    value: ResourceCommandArgument,
    operation: (uri: vscode.Uri) => Promise<void>,
  ): Promise<void> => {
    for (const uri of resourceUris(value)) {
      try {
        await operation(uri);
      } catch (error) {
        onError(scope, error);
      }
    }
  };
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
  ownership.use(registerCommand(
    'codexExtensionHelper.approveFile',
    guarded(
      'ApproveFileCommand',
      (value: ResourceCommandArgument) => runResourceCommand(
        'ApproveFileCommand',
        value,
        (uri) => controller.approveFile(uri),
      ),
    ),
  ));
  ownership.use(registerCommand(
    'codexExtensionHelper.rejectFile',
    guarded(
      'RejectFileCommand',
      (value: ResourceCommandArgument) => runResourceCommand(
        'RejectFileCommand',
        value,
        (uri) => controller.rejectFile(uri),
      ),
    ),
  ));
  ownership.use(registerCommand(
    'codexExtensionHelper.approveAllFiles',
    guarded('ApproveAllFilesCommand', () => controller.approveAllFiles()),
  ));
  ownership.use(registerCommand(
    'codexExtensionHelper.rejectAllFiles',
    guarded('RejectAllFilesCommand', () => controller.rejectAllFiles()),
  ));
}

export async function synchronizeReviewViews({
  key,
  state,
  resource,
  activeKey,
  activeState,
  views,
  isCurrent = () => true,
}: SynchronizeReviewViewsOptions): Promise<void> {
  const pending: PromiseLike<void>[] = [];
  if (key !== undefined) {
    if (state !== undefined && state.comparisonActive && state.pending) {
      if (state.lifecycle === 'deleted' || state.hunks.length === 0) {
        await views.spacers?.clear(key);
        if (!isCurrent()) {
          return;
        }
        views.renderer.clear(key);
        views.deletedLines.clear(key);
      } else {
        const presentation = await views.spacers?.install({
          key,
          canonicalText: state.currentText,
          hunks: state.hunks,
        });
        if (!isCurrent()) {
          if (
            presentation !== undefined
            && views.spacers?.presentation(key) === presentation
          ) {
            await views.spacers.clear(key);
          }
          return;
        }
        pending.push(views.renderer.render(key, state.hunks, presentation));
        views.deletedLines.update({
          key,
          sourceRevision: state.sourceRevision,
          currentText: state.currentText,
          hunks: state.hunks,
          actionLines: presentation?.plan.hunks.map((hunk) => hunk.actionLine),
        });
      }
      if (resource === undefined) {
        views.quickDiff.clear(key);
      } else if (state.lifecycle === 'deleted') {
        views.quickDiff.update(key, resource, state.baselineText, 'deleted');
      } else {
        views.quickDiff.update(key, resource, state.baselineText);
      }
    } else {
      await views.spacers?.clear(key);
      views.renderer.clear(key);
      views.deletedLines.clear(key);
      views.quickDiff.clear(key, state?.currentText);
    }
  }
  pending.push(views.activeContext.update(
    activeKey,
    activeState?.lifecycle === 'deleted' ? undefined : activeState,
  ));
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
  private readonly spacers: TemporaryLineSpacerManager;
  private readonly detector: ExternalChangeDetector;
  private readonly gitChangeGuard = new GitChangeGuard();
  private readonly documentDebouncer: PerKeyDebouncer<string>;
  private readonly ownership: DisposableStore;
  private readonly trackedUris = new Map<string, vscode.Uri>();
  private readonly comparisonKeys = new Set<string>();
  private readonly documentFence = new DocumentChangeFence();
  private readonly displayEditFence = new DisplayEditFence();
  private readonly externalCandidates = new Map<string, ExternalComparisonCandidate>();
  private readonly pendingReviewEdits = new PendingReviewEdits();
  private visibleKeys = new Set<string>();
  private disposed = false;
  private shutdownPromise: Promise<void> | undefined;

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
      const spacers = ownership.use(new TemporaryLineSpacerManager({
        document: (key): SpacerDocument | undefined => {
          const document = vscode.workspace.textDocuments.find(
            (candidate) => normalizeUriKey(candidate.uri) === key,
          );
          return document === undefined ? undefined : {
            key,
            text: document.getText(),
            version: document.version,
            isDirty: document.isDirty,
            eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
          };
        },
        apply: async (document, edits, expectedText): Promise<boolean> => {
          const live = vscode.workspace.textDocuments.find(
            (candidate) => normalizeUriKey(candidate.uri) === document.key,
          );
          if (
            live === undefined
            || live.version !== document.version
            || live.getText() !== document.text
          ) {
            return false;
          }
          const workspaceEdit = new vscode.WorkspaceEdit();
          for (const edit of edits) {
            workspaceEdit.replace(
              live.uri,
              new vscode.Range(
                live.positionAt(edit.offset),
                live.positionAt(edit.offset + edit.length),
              ),
              edit.text,
            );
          }
          if (!await vscode.workspace.applyEdit(workspaceEdit)) {
            return false;
          }
          const current = vscode.workspace.textDocuments.find(
            (candidate) => normalizeUriKey(candidate.uri) === document.key,
          );
          return current?.getText() === expectedText;
        },
        log: (scope, error) => this.log(scope, error),
      }, this.displayEditFence));
      const reviewController = ownership.use(new ReviewController(
        coordinator,
        createReviewHost(
          vscode,
          output,
          normalizeUriKey,
          (expectation) => this.pendingReviewEdits.begin(expectation),
          (key, line) => spacers.displayLine(key, line),
        ),
        (key) => this.syncComparison(key),
        (key) => this.prepareCanonicalReviewDocument(spacers, coordinator, key),
        (key, text) => spacers.presentation(key)?.displayText === text
          ? spacers.presentation(key)?.canonicalText ?? text
          : text,
        (key, line) => spacers.canonicalLine(key, line),
        () => [...this.comparisonKeys]
          .map((key) => this.trackedUris.get(key))
          .filter((resource): resource is vscode.Uri => resource !== undefined),
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
        spacers,
      };
    }, (error) => output.appendLine(`[ConstructionRollback] ${errorDetail(error)}`));

    this.ownership = construction.resources;
    this.snapshots = construction.value.snapshots;
    this.view = construction.value.view;
    this.coordinator = construction.value.coordinator;
    this.quickDiff = construction.value.quickDiff;
    this.deletedLines = construction.value.deletedLines;
    this.activeReviewContext = construction.value.activeReviewContext;
    this.spacers = construction.value.spacers;
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
    lifecycle: FileLifecycle = 'existing',
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
    if (lifecycle === 'created') {
      await this.coordinator.acceptExternalState(key, undefined);
    } else {
      this.coordinator.seed(key, baselineText);
    }
    await this.coordinator.provenChange(
      key,
      baselineText,
      currentText,
      lifecycle,
      SIMULATED_EXACT_PROVENANCE,
    );
    this.syncComparison(key);
  }

  async openActiveDiff(resource = vscode.window.activeTextEditor?.document.uri): Promise<void> {
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
    void this.shutdown();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise;
    }
    this.disposed = true;
    this.view.clearAll();
    this.deletedLines.clearAll();
    this.shutdownPromise = (async () => {
      await this.spacers.clearAll();
      this.ownership.dispose();
      this.trackedUris.clear();
      this.comparisonKeys.clear();
      this.visibleKeys.clear();
      this.externalCandidates.clear();
      this.pendingReviewEdits.clear();
      this.documentFence.clear();
      this.displayEditFence.clear();
    })();
    return this.shutdownPromise;
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
    const contentChanges = event.contentChanges.map((change) => ({
      rangeOffset: change.rangeOffset,
      rangeLength: change.rangeLength,
      text: change.text,
    })).sort((left, right) => left.rangeOffset - right.rangeOffset);
    if (this.displayEditFence.consume({
      key,
      documentVersion: event.document.version,
      resultingText: event.document.getText(),
      changes: contentChanges,
    })) {
      return;
    }

    if (this.spacers.presentation(key) !== undefined && !event.document.isDirty) {
      this.spacers.abandon(key);
      this.view.clear(key);
      this.deletedLines.clear(key);
    }

    if (this.spacers.presentation(key) !== undefined) {
      void this.run('SpacerDocumentEdit', async () => {
        const reconciled = await this.spacers.reconcileUnexpectedChange({
          key,
          documentVersion: event.document.version,
          resultingText: event.document.getText(),
          changes: contentChanges,
        });
        if (reconciled?.status === 'canonicalized') {
          this.processCanonicalDocumentEdit(key, event.document.uri, reconciled.text);
          return;
        }
        this.coordinator.save(key, event.document.getText());
        this.syncComparison(key);
        void vscode.window.showWarningMessage(
          'Codex review display was cleared because a temporary deleted-line row changed unexpectedly.',
        );
      });
      return;
    }

    const isReviewEdit = this.pendingReviewEdits.consume({
      key,
      documentVersion: event.document.version,
      resultingText: event.document.getText(),
      contentChanges,
    });
    if (isReviewEdit) {
      this.spacers.authorizeDirtyInstall({
        key,
        text: event.document.getText(),
        version: event.document.version,
        isDirty: event.document.isDirty,
        eol: event.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
      });
    }
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

    this.processCanonicalDocumentEdit(key, event.document.uri, event.document.getText());
  }

  private processCanonicalDocumentEdit(key: string, uri: vscode.Uri, text: string): void {
    this.externalCandidates.delete(key);
    this.documentFence.invalidate(key);
    this.detector.invalidate(key);
    this.coordinator.invalidate(key);
    this.documentDebouncer.cancel(key);
    const state = this.snapshots.get(key);
    if (state === undefined || !state.comparisonActive) {
      return;
    }
    if (!this.isEligible(uri, text)) {
      this.deleteKey(key);
      return;
    }

    this.documentDebouncer.schedule(key, this.settingsValue.debounceMs, () => {
      void this.run('DocumentEdit', async () => {
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
    const key = normalizeUriKey(event.document.uri);
    const spacerEdits = this.spacers.willSaveEdits({
      key,
      text: event.document.getText(),
      version: event.document.version,
      isDirty: event.document.isDirty,
      eol: event.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
    });
    event.waitUntil(Promise.resolve(spacerEdits.map((edit) => new vscode.TextEdit(
      new vscode.Range(
        event.document.positionAt(edit.offset),
        event.document.positionAt(edit.offset + edit.length),
      ),
      edit.text,
    ))));

    if (!this.disposed && this.isEligible(event.document.uri, event.document.getText())) {
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
    if (state !== undefined && state.comparisonActive && state.pending) {
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
        spacers: this.spacers,
      },
      isCurrent: () => (
        !this.disposed
        && (key === undefined || this.snapshots.get(key) === state)
      ),
    }));
  }

  private async prepareCanonicalReviewDocument(
    spacers: TemporaryLineSpacerManager,
    coordinator: ComparisonCoordinator,
    key: string,
  ): Promise<boolean> {
    const removed = await spacers.remove(key);
    if (removed.status === 'unsafe') {
      void vscode.window.showErrorMessage(
        'Could not safely remove temporary deleted-line rows before the review action.',
      );
      return false;
    }
    const document = this.liveDocument(key);
    const state = coordinator.state(key);
    const valid = state !== undefined
      && (document === undefined || document.getText() === state.currentText);
    if (!valid) {
      void vscode.window.showErrorMessage(
        'The document changed before the Codex review action could be applied.',
      );
    }
    return valid;
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

    const resource = document?.uri ?? this.trackedUris.get(key);
    if (
      resource !== undefined
      && await this.gitChangeGuard.resourceState(resource) === 'clean'
    ) {
      if (
        !this.disposed
        && this.externalCandidates.get(key) === candidate
        && this.liveDocumentMatches(key, candidate.text)
      ) {
        this.externalCandidates.delete(key);
        this.documentFence.invalidate(key);
        this.coordinator.save(key, candidate.text);
        this.syncComparison(key);
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
  private refreshTail: Promise<void> = Promise.resolve();
  private shutdownPromise: Promise<void> | undefined;

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
    lifecycle: FileLifecycle = 'existing',
  ): Promise<void> {
    await this.runtime?.simulateExternalChange(uri, baselineText, currentText, lifecycle);
  }

  async openActiveDiff(resource?: vscode.Uri): Promise<void> {
    if (this.runtime === undefined) {
      void vscode.window.showInformationMessage('Codex Extension Helper is disabled.');
      return;
    }
    await this.runtime.openActiveDiff(resource);
  }

  start(): void {
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIGURATION_SECTION)) {
        this.queueConfigurationRefresh();
      }
    }));
    this.queueConfigurationRefresh();
  }

  dispose(): void {
    void this.shutdown();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise;
    }
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0).reverse()) {
      subscription.dispose();
    }
    const runtime = this.runtime;
    this.runtime = undefined;
    this.shutdownPromise = (async () => {
      await this.refreshTail;
      await runtime?.shutdown();
      this.output?.dispose();
      this.output = undefined;
    })();
    return this.shutdownPromise;
  }

  private queueConfigurationRefresh(): void {
    this.refreshTail = this.refreshTail.then(() => this.refreshConfiguration()).catch((error) => {
      this.output ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
      this.output.appendLine(`[Configuration] ${errorDetail(error)}`);
    });
  }

  private async refreshConfiguration(): Promise<void> {
    if (this.disposed) {
      return;
    }

    try {
      const next = readSettings();
      const enabledChanged = next.enabled !== this.settings.enabled;
      const excludeChanged = !sameStrings(next.exclude, this.settings.exclude);
      this.settings = next;

      if (!next.enabled) {
        await this.runtime?.shutdown();
        this.runtime = undefined;
        if (this.disposed) {
          return;
        }
        this.output?.dispose();
        this.output = undefined;
        return;
      }

      this.output ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
      if (this.runtime === undefined || enabledChanged || excludeChanged) {
        await this.runtime?.shutdown();
        this.runtime = undefined;
        if (this.disposed) {
          return;
        }
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
    (resource?: vscode.Uri) => controller.openActiveDiff(resource),
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    'codexExtensionHelper.insertExplorerPathIntoCodex',
    async (resource?: vscode.Uri, selectedResources?: readonly vscode.Uri[]) => {
      try {
        if (process.platform !== 'darwin') {
          throw new Error('Automatic Codex paste is supported only on macOS.');
        }
        const resources = selectedResources !== undefined && selectedResources.length > 0
          ? selectedResources
          : resource === undefined
            ? []
            : [resource];
        const uniqueResources = [...new Map(resources.map((item) => [item.toString(), item])).values()];
        if (uniqueResources.length === 0) {
          throw new Error('Select a file or folder in Explorer first.');
        }

        const mentionResources: ExplorerMentionResource[] = [];
        for (const item of uniqueResources) {
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(item);
          if (item.scheme !== 'file' || workspaceFolder === undefined) {
            throw new Error('Only files and folders inside the current workspace are supported.');
          }
          const relativePath = path.relative(workspaceFolder.uri.fsPath, item.fsPath);
          const stat = await vscode.workspace.fs.stat(item);
          mentionResources.push({
            relativePath,
            fsPath: item.fsPath,
            directory: (stat.type & vscode.FileType.Directory) !== 0,
          });
        }

        const mentions = formatExplorerResourcesAsMentions(mentionResources);
        await insertMentionsIntoCodex(mentions, {
          openCodexSidebar: async () => {
            await vscode.commands.executeCommand('chatgpt.openSidebar');
          },
          waitForFocus: () => new Promise((resolve) => {
            setTimeout(resolve, CODEX_CHAT_FOCUS_DELAY_MS);
          }),
          copyPayload: (payload) => vscode.env.clipboard.writeText(payload),
          pastePayload: () => new Promise((resolve, reject) => {
            execFile('/usr/bin/osascript', ['-e', MACOS_MENTION_PASTE_SCRIPT], (error) => {
              if (error === null) {
                resolve();
              } else {
                reject(error);
              }
            });
          }),
        });
      } catch (error) {
        output.appendLine(`[Codex chat insert] ${errorDetail(error)}`);
        void vscode.window.showErrorMessage(
          'Codex @ 멘션 자동화에 실패했습니다. macOS 시스템 설정 → 개인정보 보호 및 보안 → '
          + '손쉬운 사용에서 Visual Studio Code 권한을 허용해야 합니다.',
        );
      }
    },
  ));
  const codexDropPatchController = createCodexDropPatchController(
    createCodexDropPatchRuntimeDependencies(vscode, output),
  );
  registerCodexDropPatchCommands(
    context.subscriptions,
    (command, handler) => vscode.commands.registerCommand(command, handler),
    codexDropPatchController,
  );
  if (process.env.CODEX_EXTENSION_HELPER_TEST !== '1') {
    void codexDropPatchController.offerInstallIfNeeded();
  }
  controller.start();

  return process.env.CODEX_EXTENSION_HELPER_TEST === '1'
    ? {
      testDiagnostics,
      simulateExternalChange: (uri, baselineText, currentText, lifecycle) => (
        controller.simulateExternalChange(uri, baselineText, currentText, lifecycle)
      ),
    }
    : undefined;
}

export async function deactivate(): Promise<void> {
  await activeController?.shutdown();
  activeController = undefined;
}
