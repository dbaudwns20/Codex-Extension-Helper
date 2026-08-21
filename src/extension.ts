import * as vscode from 'vscode';
import { PerKeyDebouncer } from './changePolicy';
import { ComparisonCoordinator } from './coordinator';
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
} from './externalChangeDetector';
import { InlineRenderer } from './inlineRenderer';
import { SnapshotStore } from './snapshotStore';

const CONFIGURATION_SECTION = 'codexInlineChanges';
const OUTPUT_CHANNEL_NAME = 'Codex Inline Changes';

interface TestDiagnostics {
  readonly comparisonCount: number;
  readonly renderedComparisonCount: number;
}

interface TestExtensionApi {
  readonly testDiagnostics: TestDiagnostics;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
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

class ExtensionRuntime implements vscode.Disposable {
  private readonly snapshots: SnapshotStore;
  private readonly renderer: InlineRenderer;
  private readonly view: DiagnosticView;
  private readonly coordinator: ComparisonCoordinator;
  private readonly detector: ExternalChangeDetector;
  private readonly documentDebouncer: PerKeyDebouncer<string>;
  private readonly ownership: DisposableStore;
  private readonly trackedUris = new Map<string, vscode.Uri>();
  private readonly comparisonKeys = new Set<string>();
  private readonly documentFence = new DocumentChangeFence();
  private visibleKeys = new Set<string>();
  private disposed = false;

  constructor(
    private settingsValue: ExtensionSettings,
    private readonly output: vscode.OutputChannel,
  ) {
    const construction = constructWithRollback((ownership) => {
      const snapshots = new SnapshotStore();
      const renderer = ownership.use(new InlineRenderer(vscode, output, normalizeUriKey));
      const view = new DiagnosticView(renderer);
      const coordinator = ownership.use(new ComparisonCoordinator(
        new LineDiffEngine(),
        snapshots,
        view,
      ));
      const detector = ownership.use(new ExternalChangeDetector({
        readFile: (uri) => vscode.workspace.fs.readFile(uri as vscode.Uri),
        settings: () => this.settingsValue,
        relativePath: (uri) => this.relativePath(uri as vscode.Uri),
        onComparison: async (key, text) => {
          await this.applyExternalComparison(key, text);
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
      ownership.use(vscode.workspace.onDidChangeWorkspaceFolders((event) => this.guard('WorkspaceFolders', () => this.handleWorkspaceFolders(event))));

      return { snapshots, renderer, view, coordinator, detector, documentDebouncer };
    }, (error) => output.appendLine(`[ConstructionRollback] ${errorDetail(error)}`));

    this.ownership = construction.resources;
    this.snapshots = construction.value.snapshots;
    this.renderer = construction.value.renderer;
    this.view = construction.value.view;
    this.coordinator = construction.value.coordinator;
    this.detector = construction.value.detector;
    this.documentDebouncer = construction.value.documentDebouncer;

    try {
      for (const document of vscode.workspace.textDocuments) {
        this.guard('InitialDocument', () => this.seedDocument(document));
      }
      this.guard('InitialEditors', () => this.handleVisibleEditors(vscode.window.visibleTextEditors));
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

  updateSettings(settings: ExtensionSettings): void {
    this.settingsValue = settings;
    for (const [key, uri] of [...this.trackedUris]) {
      const state = this.snapshots.get(key);
      if (state !== undefined && !this.isEligible(uri, state.currentText)) {
        this.deleteKey(key);
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.ownership.dispose();
    this.trackedUris.clear();
    this.comparisonKeys.clear();
    this.visibleKeys.clear();
    this.documentFence.clear();
  }

  private handleWatcherEvent(uri: vscode.Uri, kind: 'create' | 'change'): void {
    if (this.disposed || !this.preflightEligible(uri)) {
      return;
    }

    const key = normalizeUriKey(uri);
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
    if (
      this.disposed
      || !shouldInvalidateDocumentChange(event.contentChanges.length, event.document.isDirty)
    ) {
      return;
    }

    const key = normalizeUriKey(event.document.uri);
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
      this.view.clear(key);
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

    for (const key of this.visibleKeys) {
      if (!nextVisible.has(key)) {
        this.view.clear(key);
      }
    }
    this.visibleKeys = nextVisible;

    for (const key of nextVisible) {
      void this.run('VisibleEditor', () => this.coordinator.show(
        key,
        (expectedText) => this.liveDocumentMatches(key, expectedText),
      ));
    }
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
    this.documentFence.invalidate(key);
    if (invalidateDetector) {
      this.detector.invalidate(key);
    }
    this.documentDebouncer.cancel(key);
    this.coordinator.delete(key);
    this.trackedUris.delete(key);
    this.comparisonKeys.delete(key);
  }

  private syncComparison(key: string): void {
    const state = this.snapshots.get(key);
    if (state !== undefined && state.hunks.length > 0) {
      this.comparisonKeys.add(key);
    } else {
      this.comparisonKeys.delete(key);
    }
  }

  private async applyExternalComparison(key: string, text: string): Promise<void> {
    const isCurrent = this.createDocumentGuard(key, text);
    if (isCurrent === undefined) {
      return;
    }

    await this.coordinator.externalChange(key, text, isCurrent);
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

class ExtensionController implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
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
        this.runtime = new ExtensionRuntime(next, this.output);
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
});

export function activate(context: vscode.ExtensionContext): TestExtensionApi | undefined {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const controller = new ExtensionController(output);
  activeController = controller;
  context.subscriptions.push(controller);
  controller.start();

  return process.env.CODEX_INLINE_CHANGES_TEST === '1' ? { testDiagnostics } : undefined;
}

export function deactivate(): void {
  activeController?.dispose();
  activeController = undefined;
}
