import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { diffChars } from 'diff';
import { describe, expect, it, vi } from 'vitest';
import { DisposableStore } from '../../src/disposableStore';
import type { ChangeHunk, FileComparisonState, HunkReference } from '../../src/types';

const vscodeMock = vi.hoisted(() => ({} as Record<string, unknown>));

vi.mock('vscode', () => vscodeMock);

class FakeRange {
  readonly start: unknown;
  readonly end: unknown;

  constructor(
    startOrLine: unknown,
    startCharacterOrEnd: unknown,
    endLine?: number,
    endCharacter?: number,
  ) {
    if (endLine === undefined || endCharacter === undefined) {
      this.start = startOrLine;
      this.end = startCharacterOrEnd;
    } else {
      this.start = { line: startOrLine, character: startCharacterOrEnd };
      this.end = { line: endLine, character: endCharacter };
    }
  }
}

class FakeSelection {
  constructor(readonly anchor: unknown, readonly active: unknown) {}
}

class FakeCodeLens {
  constructor(readonly range: unknown, readonly command?: {
    readonly command: string;
    readonly arguments?: readonly unknown[];
  }) {}
}

class FakeWorkspaceEdit {
  readonly replacements: unknown[][] = [];

  replace(...replacement: unknown[]): void {
    this.replacements.push(replacement);
  }
}

class FakeEventEmitter<T> {
  readonly event = vi.fn();
  readonly fire = vi.fn((_value?: T) => undefined);
  readonly dispose = vi.fn();
}

class FakeThemeColor {
  constructor(readonly id: string) {}
}

class FakeTabInputText {
  constructor(readonly uri: unknown) {}
}

function reviewDocument(text = 'before after\n') {
  const uri = { toString: () => 'file:///workspace/file.ts' };
  return {
    uri,
    version: 4,
    lineCount: 2,
    eol: 1,
    getText: vi.fn(() => text),
    positionAt: vi.fn((offset: number) => ({ offset })),
  };
}

function reviewState(overrides: Partial<FileComparisonState> = {}): FileComparisonState {
  const hunks: readonly ChangeHunk[] = [{
    kind: 'modification',
    originalStart: 0,
    originalEnd: 1,
    modifiedStart: 0,
    modifiedEnd: 1,
    originalLines: ['before'],
    modifiedLines: ['after'],
  }];
  return {
    baselineText: 'partially approved baseline\n',
    currentText: 'live document\n',
    hunks,
    sourceRevision: 9,
    comparisonActive: true,
    pending: true,
    createdFile: false,
    ...overrides,
  };
}

function disjointFakeChanges(originalText: string, resultingText: string) {
  const changes: Array<{ rangeOffset: number; rangeLength: number; text: string }> = [];
  let originalOffset = 0;
  let pending: { rangeOffset: number; rangeLength: number; text: string } | undefined;
  const flush = () => {
    if (pending !== undefined) {
      changes.push(pending);
      pending = undefined;
    }
  };

  for (const part of diffChars(originalText, resultingText)) {
    if (!part.added && !part.removed) {
      flush();
      originalOffset += part.value.length;
      continue;
    }
    pending ??= { rangeOffset: originalOffset, rangeLength: 0, text: '' };
    if (part.removed) {
      pending.rangeLength += part.value.length;
      originalOffset += part.value.length;
    } else {
      pending.text += part.value;
    }
  }
  flush();
  return changes;
}

async function settleRuntime(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await vi.runAllTimersAsync();
    await Promise.resolve();
  }
}

function installRuntimeVscode(initialText = 'before\n') {
  const callbacks = new Map<string, (...args: any[]) => unknown>();
  const commands = new Map<string, (...args: any[]) => unknown>();
  const uri = {
    scheme: 'file',
    authority: '',
    path: '/workspace/file.ts',
    fsPath: '/workspace/file.ts',
    toString: () => 'file:///workspace/file.ts',
    with(changes: Record<string, string>) {
      const scheme = changes.scheme ?? this.scheme;
      return {
        ...this,
        ...changes,
        scheme,
        toString: () => `${scheme}:///workspace/file.ts?${changes.query ?? ''}`,
      };
    },
  };
  let text = initialText;
  let version = 1;
  let dirty = false;
  let enabled = true;
  const document = {
    uri,
    get isDirty() {
      return dirty;
    },
    get lineCount() {
      return text.split('\n').length;
    },
    eol: 1,
    get version() {
      return version;
    },
    getText: () => text,
    positionAt: (offset: number) => ({ offset }),
    lineAt: (line: number) => ({ range: { end: { character: line + 1 } } }),
  };
  const editor = {
    document,
    viewColumn: 1,
    selection: { active: { line: 0 } },
    setDecorations: vi.fn(),
    revealRange: vi.fn(),
  };
  const secondUri = {
    ...uri,
    path: '/workspace/second.ts',
    fsPath: '/workspace/second.ts',
    toString: () => 'file:///workspace/second.ts',
  };
  const secondDocument = {
    ...document,
    uri: secondUri,
    version: 1,
    getText: () => 'second\n',
  };
  const secondEditor = {
    ...editor,
    document: secondDocument,
    selection: { active: { line: 0 } },
    setDecorations: vi.fn(),
    revealRange: vi.fn(),
  };
  const disposables: { dispose(): void }[] = [];
  const disposable = () => {
    const value = { dispose: vi.fn() };
    disposables.push(value);
    return value;
  };
  const event = (name: string) => (callback: (...args: any[]) => unknown) => {
    callbacks.set(name, callback);
    return disposable();
  };
  const watcher = {
    onDidCreate: event('watcherCreate'),
    onDidChange: event('watcherChange'),
    onDidDelete: event('watcherDelete'),
    dispose: vi.fn(),
  };
  const sourceControl = {
    inputBox: { visible: true },
    count: 0,
    quickDiffProvider: undefined as unknown,
    dispose: vi.fn(),
  };
  const createSourceControl = vi.fn(() => sourceControl);
  let contentProvider: { provideTextDocumentContent(uri: unknown): string } | undefined;
  let codeLensProvider: { provideCodeLenses(document: unknown): FakeCodeLens[] } | undefined;
  const window = {
    activeTextEditor: editor as typeof editor | typeof secondEditor | undefined,
    visibleTextEditors: [editor] as Array<typeof editor | typeof secondEditor>,
    tabGroups: {
      all: [{
        viewColumn: 1,
        activeTab: { input: new FakeTabInputText(uri) },
      }],
    },
    createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
    createOutputChannel: vi.fn(),
    onDidChangeVisibleTextEditors: event('visibleEditors'),
    onDidChangeActiveTextEditor: event('activeEditor'),
  };
  const workspace = {
    textDocuments: [document] as Array<typeof document | typeof secondDocument>,
    fs: {
      readFile: vi.fn(async () => new TextEncoder().encode(text)),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    applyEdit: vi.fn(async (edit: FakeWorkspaceEdit) => {
      if (edit.replacements.length === 0) {
        return false;
      }
      const originalText = text;
      for (const replacement of edit.replacements) {
        const range = replacement[1] as FakeRange;
        const startOffset = (range.start as { offset: number }).offset;
        const endOffset = (range.end as { offset: number }).offset;
        const replacementText = String(replacement[2]);
        text = text.slice(0, startOffset) + replacementText + text.slice(endOffset);
      }
      version += 1;
      callbacks.get('documentChange')?.({
        document,
        contentChanges: disjointFakeChanges(originalText, text),
      });
      dirty = true;
      return true;
    }),
    createFileSystemWatcher: vi.fn(() => watcher),
    registerTextDocumentContentProvider: vi.fn((_scheme: string, provider: typeof contentProvider) => {
      contentProvider = provider;
      return disposable();
    }),
    getConfiguration: vi.fn(() => ({
      get: (key: string) => ({
        enabled,
        debounceMs: 0,
        maxFileSizeKb: 1,
        exclude: [],
      })[key],
    })),
    onDidChangeConfiguration: event('configuration'),
    onDidOpenTextDocument: event('documentOpen'),
    onDidChangeTextDocument: event('documentChange'),
    onWillSaveTextDocument: event('documentWillSave'),
    onDidSaveTextDocument: event('documentSave'),
    onDidCloseTextDocument: event('documentClose'),
    onDidChangeWorkspaceFolders: event('workspaceFolders'),
    getWorkspaceFolder: vi.fn(() => ({ uri: { path: '/workspace' } })),
    asRelativePath: vi.fn((resource: { path: string }) => resource.path.slice('/workspace/'.length)),
  };
  const executeCommand = vi.fn().mockResolvedValue(undefined);
  const output = { appendLine: vi.fn(), dispose: vi.fn() };
  window.createOutputChannel.mockReturnValue(output);
  Object.assign(vscodeMock, {
    window,
    workspace,
    extensions: { getExtension: vi.fn(() => undefined) },
    languages: {
      registerCodeLensProvider: vi.fn((_selector: unknown, provider: typeof codeLensProvider) => {
        codeLensProvider = provider;
        return disposable();
      }),
    },
    scm: { createSourceControl },
    commands: {
      executeCommand,
      registerCommand: vi.fn((command: string, callback: (...args: any[]) => unknown) => {
        commands.set(command, callback);
        return disposable();
      }),
    },
    EventEmitter: FakeEventEmitter,
    WorkspaceEdit: FakeWorkspaceEdit,
    Range: FakeRange,
    CodeLens: FakeCodeLens,
    Selection: FakeSelection,
    ThemeColor: FakeThemeColor,
    TabInputText: FakeTabInputText,
    EndOfLine: { LF: 1, CRLF: 2 },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    OverviewRulerLane: { Full: 7 },
    TextEditorRevealType: { InCenter: 9 },
  });

  return {
    callbacks,
    codeLenses() {
      return codeLensProvider?.provideCodeLenses(document) ?? [];
    },
    commands,
    createSourceControl,
    currentText() {
      return text;
    },
    document,
    editor,
    executeCommand,
    output,
    quickDiffBaseline(): string | undefined {
      const provider = sourceControl.quickDiffProvider as {
        provideOriginalResource(uri: unknown): unknown;
      } | undefined;
      const baseline = provider?.provideOriginalResource(uri);
      return baseline === undefined
        ? undefined
        : contentProvider?.provideTextDocumentContent(baseline);
    },
    secondDocument,
    secondEditor,
    setText(value: string, isDirty = false) {
      text = value;
      version += 1;
      dirty = isDirty;
    },
    setEnabled(value: boolean) {
      enabled = value;
    },
    sourceControl,
    uri,
    window,
    workspace,
  };
}

describe('packaged runtime', () => {
  it('registers Codex drop patch management commands during activation', async () => {
    const fake = installRuntimeVscode();
    const previousTestMode = process.env.CODEX_EXTENSION_HELPER_TEST;
    process.env.CODEX_EXTENSION_HELPER_TEST = '1';
    const context = { subscriptions: [] as { dispose(): unknown }[] };

    try {
      const { activate, deactivate } = await import('../../src/extension');
      activate(context as never);

      expect([...fake.commands.keys()]).toEqual(expect.arrayContaining([
        'codexExtensionHelper.installCodexDropPatch',
        'codexExtensionHelper.removeCodexDropPatch',
        'codexExtensionHelper.showCodexDropPatchStatus',
      ]));
      await fake.commands.get('codexExtensionHelper.showCodexDropPatchStatus')!();
      expect(fake.window.showInformationMessage).toHaveBeenCalledWith(
        'The OpenAI Codex extension is not installed.',
      );

      await deactivate();
    } finally {
      if (previousTestMode === undefined) delete process.env.CODEX_EXTENSION_HELPER_TEST;
      else process.env.CODEX_EXTENSION_HELPER_TEST = previousTestMode;
    }
  });

  it('keeps externally saved source clean while rendering a replacement diff', async () => {
    vi.useFakeTimers();
    try {
      const modified = 'new line\nkeep\n';
      const fake = installRuntimeVscode('old line\nkeep\n');
      const { ExtensionRuntime } = await import('../../src/extension');
      const runtime = new ExtensionRuntime({
        enabled: true,
        debounceMs: 0,
        maxFileSizeBytes: 1024,
        exclude: [],
      }, fake.output as never, {
        renderingDisabled: false,
        warningShown: false,
      });

      fake.setText(modified);
      fake.callbacks.get('watcherChange')!(fake.uri);
      await settleRuntime();

      expect(runtime.renderedComparisonCount).toBe(1);
      expect(fake.currentText()).toBe(modified);
      expect(fake.document.isDirty).toBe(false);

      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('registers Codex Changes only while a tracked comparison exists', async () => {
    vi.useFakeTimers();
    try {
      const fake = installRuntimeVscode('before\n');
      const { ExtensionRuntime } = await import('../../src/extension');
      const runtime = new ExtensionRuntime({
        enabled: true,
        debounceMs: 0,
        maxFileSizeBytes: 1024,
        exclude: [],
      }, fake.output as never, {
        renderingDisabled: false,
        warningShown: false,
      });

      expect(fake.createSourceControl).not.toHaveBeenCalled();

      fake.setText('after\n');
      fake.callbacks.get('watcherChange')!(fake.uri);
      await settleRuntime();

      expect(fake.createSourceControl).toHaveBeenCalledTimes(1);
      expect(fake.quickDiffBaseline()).toBe('before\n');

      fake.callbacks.get('watcherDelete')!(fake.uri);
      await settleRuntime();

      expect(fake.sourceControl.dispose).toHaveBeenCalledTimes(1);
      runtime.dispose();
      expect(fake.sourceControl.dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads with vscode as its only external module', async () => {
    const temporaryPath = await mkdtemp(path.join(tmpdir(), 'codex-inline-runtime-'));

    try {
      const runtimePath = path.join(temporaryPath, 'out', 'src');
      const vscodeStubPath = path.join(temporaryPath, 'node_modules', 'vscode');
      await mkdir(runtimePath, { recursive: true });
      await copyFile(path.resolve('out/src/extension.js'), path.join(runtimePath, 'extension.js'));
      await mkdir(vscodeStubPath, { recursive: true });
      await writeFile(
        path.join(vscodeStubPath, 'package.json'),
        JSON.stringify({ name: 'vscode', version: '0.0.0', main: 'index.js' }),
        'utf8',
      );
      await writeFile(path.join(vscodeStubPath, 'index.js'), 'module.exports = {};\n', 'utf8');

      const entryPath = path.join(runtimePath, 'extension.js');
      const result = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', entryPath], {
        cwd: temporaryPath,
        encoding: 'utf8',
      });

      expect(result.status, result.stderr).toBe(0);
    } finally {
      await rm(temporaryPath, { recursive: true, force: true });
    }
  });

  it('lists exactly the runtime, manifest, license, and user documentation for packaging', () => {
    const executable = path.resolve(
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'vsce.cmd' : 'vsce',
    );
    const result = spawnSync(executable, ['ls', '--no-dependencies'], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split(/\r?\n/u).filter(Boolean)).toEqual([
      'package.json',
      'THIRD_PARTY_NOTICES.txt',
      'README.md',
      'LICENSE',
      'CHANGELOG.md',
      'out/src/extension.js',
    ]);
  }, 15_000);

  it('packages the recipient license and third-party notices', async () => {
    const executable = path.resolve(
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'vsce.cmd' : 'vsce',
    );
    const temporaryPath = await mkdtemp(path.join(tmpdir(), 'codex-inline-package-'));

    try {
      const packageResult = spawnSync(executable, [
        'package',
        '--no-dependencies',
        '--out',
        path.join(temporaryPath, 'extension.vsix'),
      ], {
        cwd: path.resolve('.'),
        encoding: 'utf8',
      });
      const listResult = spawnSync(executable, ['ls', '--no-dependencies'], {
        cwd: path.resolve('.'),
        encoding: 'utf8',
      });

      expect(packageResult.status, packageResult.stderr).toBe(0);
      expect(listResult.status, listResult.stderr).toBe(0);
      expect(listResult.stdout.split(/\r?\n/u)).toEqual(expect.arrayContaining([
        'LICENSE',
        'THIRD_PARTY_NOTICES.txt',
      ]));
    } finally {
      await rm(temporaryPath, { recursive: true, force: true });
    }
  }, 30_000);

  it('documents the Codex Explorer drop patch workflow', async () => {
    const readme = await readFile(path.resolve('README.md'), 'utf8');

    expect(readme).toContain('Apply and Reload');
    expect(readme).toContain('Codex Helper: Install/Repair Drop Patch');
    expect(readme).toContain('Codex Helper: Remove Drop Patch');
    expect(readme).toContain('included in the VSIX');
    expect(readme).toContain('npm run patch:codex-drop');
    expect(readme).toContain('npm run unpatch:codex-drop');
    expect(readme).toContain('openai.chatgpt-*');
    expect(readme).toContain('Reload VS Code');
    expect(readme).toContain('numerically newest installed');
    expect(readme).toContain('fails closed');
    expect(readme).toContain('--extension-dir');
    expect(readme).toContain('older side-by-side installation');
  });
});

describe('stable review runtime boundaries', () => {
  it('consumes two separated edit spans in either event array order', async () => {
    const module = await import('../../src/extension');
    const PendingReviewEdits = (module as unknown as {
      PendingReviewEdits?: new () => {
        begin(expectation: Record<string, unknown>): () => void;
        consume(event: Record<string, unknown>): boolean;
      };
    }).PendingReviewEdits;
    expect(PendingReviewEdits).toBeTypeOf('function');

    const expectation = {
      key: 'file:///workspace/file.ts',
      startingVersion: 4,
      originalText: 'aa11bb22cc',
      resultingText: 'aaXXbbYYcc',
    };
    const matchingEvent = {
      key: expectation.key,
      documentVersion: 5,
      resultingText: expectation.resultingText,
      contentChanges: [
        { rangeOffset: 2, rangeLength: 2, text: 'XX' },
        { rangeOffset: 6, rangeLength: 2, text: 'YY' },
      ],
    };

    for (const contentChanges of [
      matchingEvent.contentChanges,
      [...matchingEvent.contentChanges].reverse(),
    ]) {
      const edits = new PendingReviewEdits!();
      edits.begin(expectation);
      expect(edits.consume({ ...matchingEvent, contentChanges })).toBe(true);
    }
  });

  it('rejects malformed, overlapping, out-of-bounds, incomplete, and unrelated changes', async () => {
    const module = await import('../../src/extension');
    const PendingReviewEdits = (module as unknown as {
      PendingReviewEdits: new () => {
        begin(expectation: Record<string, unknown>): () => void;
        consume(event: Record<string, unknown>): boolean;
      };
    }).PendingReviewEdits;
    const expectation = {
      key: 'file:///workspace/file.ts',
      startingVersion: 4,
      originalText: 'aa11bb22cc',
      resultingText: 'aaXXbbYYcc',
    };
    const matchingEvent = {
      key: expectation.key,
      documentVersion: 5,
      resultingText: expectation.resultingText,
      contentChanges: [
        { rangeOffset: 2, rangeLength: 2, text: 'XX' },
        { rangeOffset: 6, rangeLength: 2, text: 'YY' },
      ],
    };

    for (const mismatchedEvent of [
      { ...matchingEvent, documentVersion: 6 },
      { ...matchingEvent, resultingText: 'aaXXbbYYcc!' },
      { ...matchingEvent, contentChanges: [] },
      { ...matchingEvent, contentChanges: [{ rangeOffset: 2, rangeLength: 2, text: 'XX' }] },
      { ...matchingEvent, contentChanges: [
        { rangeOffset: 2, rangeLength: 4, text: 'XX' },
        { rangeOffset: 4, rangeLength: 2, text: 'YY' },
      ] },
      { ...matchingEvent, contentChanges: [
        { rangeOffset: -1, rangeLength: 2, text: 'XX' },
        { rangeOffset: 6, rangeLength: 2, text: 'YY' },
      ] },
      { ...matchingEvent, contentChanges: [
        { rangeOffset: 2.5, rangeLength: 2, text: 'XX' },
        { rangeOffset: 6, rangeLength: 2, text: 'YY' },
      ] },
      { ...matchingEvent, contentChanges: [
        { rangeOffset: 2, rangeLength: 2, text: 'XX' },
        { rangeOffset: 9, rangeLength: 2, text: 'YY' },
      ] },
      { ...matchingEvent, contentChanges: [
        { rangeOffset: 2, rangeLength: 2, text: 'ZZ' },
        { rangeOffset: 6, rangeLength: 2, text: 'YY' },
      ] },
    ]) {
      const edits = new PendingReviewEdits();
      edits.begin(expectation);
      expect(edits.consume(mismatchedEvent)).toBe(false);
      expect(edits.consume(matchingEvent)).toBe(false);
    }
  });

  it('rejects a matching payload when the event document result differs', async () => {
    const module = await import('../../src/extension');
    const PendingReviewEdits = (module as unknown as {
      PendingReviewEdits: new () => {
        begin(expectation: Record<string, unknown>): () => void;
        consume(event: Record<string, unknown>): boolean;
      };
    }).PendingReviewEdits;
    const edits = new PendingReviewEdits();
    edits.begin({
      key: 'file:///workspace/file.ts',
      startingVersion: 4,
      originalText: 'aa11bb22cc',
      resultingText: 'aaXXbbYYcc',
    });

    expect(edits.consume({
      key: 'file:///workspace/file.ts',
      documentVersion: 5,
      resultingText: 'aaXXbbYYcc!',
      contentChanges: [
        { rangeOffset: 2, rangeLength: 2, text: 'XX' },
        { rangeOffset: 6, rangeLength: 2, text: 'YY' },
      ],
    })).toBe(false);
  });

  it('invalidates only the malformed event token and preserves another file token', async () => {
    const module = await import('../../src/extension');
    const PendingReviewEdits = (module as unknown as {
      PendingReviewEdits: new () => {
        begin(expectation: Record<string, unknown>): () => void;
        consume(event: Record<string, unknown>): boolean;
      };
    }).PendingReviewEdits;
    const edits = new PendingReviewEdits();
    edits.begin({
      key: 'file:///workspace/first.ts',
      startingVersion: 4,
      originalText: 'aa11bb22cc',
      resultingText: 'aaXXbbYYcc',
    });
    edits.begin({
      key: 'file:///workspace/second.ts',
      startingVersion: 8,
      originalText: 'm1n',
      resultingText: 'm2n',
    });

    expect(edits.consume({
      key: 'file:///workspace/first.ts',
      documentVersion: 5,
      resultingText: 'aaXXbbYYcc',
      contentChanges: [
        { rangeOffset: 2, rangeLength: 4, text: 'XX' },
        { rangeOffset: 4, rangeLength: 2, text: 'YY' },
      ],
    })).toBe(false);
    expect(edits.consume({
      key: 'file:///workspace/second.ts',
      documentVersion: 9,
      resultingText: 'm2n',
      contentChanges: [{ rangeOffset: 1, rangeLength: 1, text: '2' }],
    })).toBe(true);
  });

  it('keeps nested review-edit cleanup scoped to the token that registered it', async () => {
    const module = await import('../../src/extension');
    const PendingReviewEdits = (module as unknown as {
      PendingReviewEdits: new () => {
        begin(expectation: Record<string, unknown>): () => void;
        consume(event: Record<string, unknown>): boolean;
      };
    }).PendingReviewEdits;
    const edits = new PendingReviewEdits();
    const first = {
      key: 'file:///workspace/file.ts',
      startingVersion: 4,
      originalText: 'before',
      resultingText: 'after-one',
    };
    const second = { ...first, startingVersion: 5, resultingText: 'after-two' };

    const finishFirst = edits.begin(first);
    const finishSecond = edits.begin(second);
    finishFirst();

    expect(edits.consume({
      key: second.key,
      documentVersion: 6,
      resultingText: second.resultingText,
      contentChanges: [{ rangeOffset: 0, rangeLength: 6, text: 'after-two' }],
    })).toBe(true);
    finishSecond();
  });

  it('does not classify a delayed event after an unconsumed token is finished', async () => {
    const module = await import('../../src/extension');
    const PendingReviewEdits = (module as unknown as {
      PendingReviewEdits: new () => {
        begin(expectation: Record<string, unknown>): () => void;
        consume(event: Record<string, unknown>): boolean;
      };
    }).PendingReviewEdits;
    const edits = new PendingReviewEdits();
    const expectation = {
      key: 'file:///workspace/file.ts',
      startingVersion: 4,
      originalText: 'after\n',
      resultingText: 'before\n',
    };
    const finish = edits.begin(expectation);

    finish();

    expect(edits.consume({
      key: expectation.key,
      documentVersion: 5,
      resultingText: expectation.resultingText,
      contentChanges: [{ rangeOffset: 0, rangeLength: 5, text: 'before' }],
    })).toBe(false);
  });

  it('applies hunk and full-document replacements with positionAt-derived ranges', async () => {
    const { createReviewHost } = await import('../../src/extension');
    const document = reviewDocument();
    const editor = {
      document,
      selection: { active: { line: 1 } },
      revealRange: vi.fn(),
    };
    const applyEdit = vi.fn().mockResolvedValue(true);
    const api = {
      window: { activeTextEditor: editor, showErrorMessage: vi.fn() },
      workspace: { applyEdit, fs: { delete: vi.fn() } },
      WorkspaceEdit: FakeWorkspaceEdit,
      Range: FakeRange,
      Selection: FakeSelection,
      TextEditorRevealType: { InCenter: 9 },
    };
    const host = createReviewHost(api as never, { appendLine: vi.fn() }, (uri) => uri.toString());
    const active = host.activeDocument();
    expect(active).toBeDefined();

    await expect(host.applyReplacement(active!, {
      startOffset: 2,
      endOffset: 8,
      replacementText: 'replacement',
    })).resolves.toBe(true);
    await expect(host.replaceAll(active!, 'baseline')).resolves.toBe(true);

    expect(document.positionAt.mock.calls).toEqual([[2], [8], [0], [13]]);
    expect(applyEdit).toHaveBeenCalledTimes(2);
    expect((applyEdit.mock.calls[0][0] as FakeWorkspaceEdit).replacements).toEqual([[
      document.uri,
      new FakeRange({ offset: 2 }, { offset: 8 }),
      'replacement',
    ]]);
    expect((applyEdit.mock.calls[1][0] as FakeWorkspaceEdit).replacements).toEqual([[
      document.uri,
      new FakeRange({ offset: 0 }, { offset: 13 }),
      'baseline',
    ]]);
  });

  it('registers an exact edit token immediately around applyEdit and cleans false and thrown calls', async () => {
    const { createReviewHost } = await import('../../src/extension');
    const document = reviewDocument('const value = 11;');
    const editor = {
      document,
      selection: { active: { line: 1 } },
      revealRange: vi.fn(),
    };
    const finish = vi.fn();
    const begin = vi.fn(() => finish);
    const applyEdit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('apply failed'));
    const api = {
      window: { activeTextEditor: editor, showErrorMessage: vi.fn() },
      workspace: { applyEdit, fs: { delete: vi.fn() } },
      WorkspaceEdit: FakeWorkspaceEdit,
      Range: FakeRange,
      Selection: FakeSelection,
      TextEditorRevealType: { InCenter: 9 },
    };
    const host = createReviewHost(
      api as never,
      { appendLine: vi.fn() },
      (uri) => uri.toString(),
      begin as never,
    );
    const active = host.activeDocument()!;

    await expect(host.replaceAll(active, 'const value = 10;')).resolves.toBe(false);
    await expect(host.replaceAll(active, 'const value = 10;')).rejects.toThrow('apply failed');

    expect(begin).toHaveBeenNthCalledWith(1, {
      key: 'file:///workspace/file.ts',
      startingVersion: 4,
      originalText: 'const value = 11;',
      resultingText: 'const value = 10;',
    });
    expect(finish).toHaveBeenCalledTimes(2);
  });

  it('deletes through VS Code trash and reveals a collapsed centered active selection', async () => {
    const { createReviewHost } = await import('../../src/extension');
    const document = reviewDocument();
    const editor = {
      document,
      selection: { active: { line: 1 } },
      revealRange: vi.fn(),
    };
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const api = {
      window: { activeTextEditor: editor, showErrorMessage: vi.fn() },
      workspace: { applyEdit: vi.fn(), fs: { delete: deleteFile } },
      WorkspaceEdit: FakeWorkspaceEdit,
      Range: FakeRange,
      Selection: FakeSelection,
      TextEditorRevealType: { InCenter: 9 },
    };
    const host = createReviewHost(api as never, { appendLine: vi.fn() }, (uri) => uri.toString());
    const active = host.activeDocument();
    expect(active).toMatchObject({
      uri: document.uri,
      key: 'file:///workspace/file.ts',
      text: 'before after\n',
      version: 4,
      cursorLine: 1,
      lineCount: 2,
      eol: 1,
    });

    await host.deleteToTrash(document.uri as never);
    host.reveal(active!, 7);

    expect(deleteFile).toHaveBeenCalledWith(document.uri, { useTrash: true });
    expect(editor.selection).toEqual(new FakeSelection(
      { line: 1, character: 0 },
      { line: 1, character: 0 },
    ));
    expect(editor.revealRange).toHaveBeenCalledWith(
      new FakeRange(1, 0, 1, 0),
      9,
    );
  });

  it('registers each review command through disposable ownership and forwards arguments', async () => {
    const { registerReviewCommands } = await import('../../src/extension');
    const ownership = new DisposableStore();
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const disposals: ReturnType<typeof vi.fn>[] = [];
    const registerCommand = vi.fn((command: string, handler: (...args: never[]) => unknown) => {
      handlers.set(command, handler);
      const dispose = vi.fn();
      disposals.push(dispose);
      return { dispose };
    });
    const controller = {
      approveHunk: vi.fn(),
      rejectHunk: vi.fn(),
      previousChange: vi.fn(),
      nextChange: vi.fn(),
      approveAll: vi.fn(),
      rejectAll: vi.fn(),
    };
    registerReviewCommands(ownership, registerCommand, controller);
    const reference: HunkReference = {
      key: 'file:///workspace/file.ts',
      sourceRevision: 3,
      hunkIndex: 1,
      expectedText: 'current\n',
    };
    const uri = { toString: () => reference.key };

    await handlers.get('codexExtensionHelper.approveHunk')!(reference as never);
    await handlers.get('codexExtensionHelper.rejectHunk')!(reference as never);
    handlers.get('codexExtensionHelper.previousChange')!(uri as never);
    handlers.get('codexExtensionHelper.nextChange')!(uri as never);
    await handlers.get('codexExtensionHelper.approveAll')!(uri as never);
    await handlers.get('codexExtensionHelper.rejectAll')!(uri as never);

    expect([...handlers.keys()]).toEqual([
      'codexExtensionHelper.approveHunk',
      'codexExtensionHelper.rejectHunk',
      'codexExtensionHelper.previousChange',
      'codexExtensionHelper.nextChange',
      'codexExtensionHelper.approveAll',
      'codexExtensionHelper.rejectAll',
    ]);
    expect(controller.approveHunk).toHaveBeenCalledWith(reference);
    expect(controller.rejectHunk).toHaveBeenCalledWith(reference);
    expect(controller.previousChange).toHaveBeenCalledWith(uri);
    expect(controller.nextChange).toHaveBeenCalledWith(uri);
    expect(controller.approveAll).toHaveBeenCalledWith(uri);
    expect(controller.rejectAll).toHaveBeenCalledWith(uri);

    ownership.dispose();
    expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it('contains rejected command callbacks and reports them without leaking a rejection', async () => {
    const { registerReviewCommands } = await import('../../src/extension');
    const ownership = new DisposableStore();
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const failure = new Error('approval failed');
    const onError = vi.fn();
    registerReviewCommands(
      ownership,
      (command, handler) => {
        handlers.set(command, handler);
        return { dispose: vi.fn() };
      },
      {
        approveHunk: vi.fn().mockRejectedValue(failure),
        rejectHunk: vi.fn(),
        previousChange: vi.fn(),
        nextChange: vi.fn(),
        approveAll: vi.fn(),
        rejectAll: vi.fn(),
      },
      onError,
    );

    await expect(handlers.get('codexExtensionHelper.approveHunk')!({}))
      .resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('ApproveHunkCommand', failure);

    ownership.dispose();
  });

  it('synchronizes every review view from one latest partially accepted state', async () => {
    const { synchronizeReviewViews } = await import('../../src/extension');
    const key = 'file:///workspace/file.ts';
    const resource = { toString: () => key };
    const state = reviewState();
    const activeState = reviewState({ sourceRevision: 11 });
    const views = {
      renderer: { render: vi.fn().mockResolvedValue(undefined), clear: vi.fn() },
      deletedLines: { update: vi.fn(), clear: vi.fn() },
      quickDiff: { update: vi.fn(), clear: vi.fn() },
      activeContext: { update: vi.fn().mockResolvedValue(undefined) },
    };

    await synchronizeReviewViews({
      key,
      state,
      resource: resource as never,
      activeKey: 'file:///workspace/active.ts',
      activeState,
      views,
    });

    expect(views.renderer.render).toHaveBeenCalledWith(key, state.hunks, undefined);
    expect(views.deletedLines.update).toHaveBeenCalledWith({
      key,
      sourceRevision: 9,
      currentText: 'live document\n',
      hunks: state.hunks,
      actionLines: undefined,
    });
    expect(views.quickDiff.update).toHaveBeenCalledWith(
      key,
      resource,
      'partially approved baseline\n',
    );
    expect(views.activeContext.update).toHaveBeenCalledWith(
      'file:///workspace/active.ts',
      activeState,
    );
  });

  it('clears file views while deriving title context from the unchanged active file', async () => {
    const { synchronizeReviewViews } = await import('../../src/extension');
    const state = reviewState({
      baselineText: 'accepted\n',
      currentText: 'accepted\n',
      hunks: [],
      comparisonActive: false,
      pending: false,
    });
    const activeState = reviewState();
    const views = {
      renderer: { render: vi.fn(), clear: vi.fn() },
      deletedLines: { update: vi.fn(), clear: vi.fn() },
      quickDiff: { update: vi.fn(), clear: vi.fn() },
      activeContext: { update: vi.fn().mockResolvedValue(undefined) },
    };

    await synchronizeReviewViews({
      key: 'file:///workspace/inactive.ts',
      state,
      resource: undefined,
      activeKey: 'file:///workspace/active.ts',
      activeState,
      views,
    });

    expect(views.renderer.clear).toHaveBeenCalledWith('file:///workspace/inactive.ts');
    expect(views.deletedLines.clear).toHaveBeenCalledWith('file:///workspace/inactive.ts');
    expect(views.quickDiff.clear).toHaveBeenCalledWith(
      'file:///workspace/inactive.ts',
      'accepted\n',
    );
    expect(views.activeContext.update).toHaveBeenCalledWith(
      'file:///workspace/active.ts',
      activeState,
    );
  });

  it('updates only active context when synchronization has no eligible file', async () => {
    const { synchronizeReviewViews } = await import('../../src/extension');
    const views = {
      renderer: { render: vi.fn(), clear: vi.fn() },
      deletedLines: { update: vi.fn(), clear: vi.fn() },
      quickDiff: { update: vi.fn(), clear: vi.fn() },
      activeContext: { update: vi.fn().mockResolvedValue(undefined) },
    };

    await synchronizeReviewViews({
      key: undefined,
      state: undefined,
      resource: undefined,
      activeKey: undefined,
      activeState: undefined,
      views,
    });

    expect(views.renderer.render).not.toHaveBeenCalled();
    expect(views.renderer.clear).not.toHaveBeenCalled();
    expect(views.deletedLines.update).not.toHaveBeenCalled();
    expect(views.deletedLines.clear).not.toHaveBeenCalled();
    expect(views.quickDiff.update).not.toHaveBeenCalled();
    expect(views.quickDiff.clear).not.toHaveBeenCalled();
    expect(views.activeContext.update).toHaveBeenCalledWith(undefined, undefined);
  });

  it('wires command and active-file context lifecycles inside the extension runtime', async () => {
    vi.useFakeTimers();
    try {
      const fake = installRuntimeVscode();
      const { ExtensionRuntime } = await import('../../src/extension');
      const runtime = new ExtensionRuntime({
        enabled: true,
        debounceMs: 0,
        maxFileSizeBytes: 1024,
        exclude: [],
      }, fake.output as never, {
        renderingDisabled: false,
        warningShown: false,
      });

      expect([...fake.commands.keys()]).toEqual([
        'codexExtensionHelper.approveHunk',
        'codexExtensionHelper.rejectHunk',
        'codexExtensionHelper.previousChange',
        'codexExtensionHelper.nextChange',
        'codexExtensionHelper.approveAll',
        'codexExtensionHelper.rejectAll',
      ]);

      fake.setText('after\n');
      fake.callbacks.get('watcherChange')!(fake.uri);
      await settleRuntime();
      expect(fake.executeCommand).toHaveBeenLastCalledWith(
        'setContext',
        'codexExtensionHelper.activeFileHasChanges',
        true,
      );

      fake.workspace.textDocuments.push(fake.secondDocument);
      fake.window.activeTextEditor = fake.secondEditor;
      fake.window.visibleTextEditors = [fake.editor, fake.secondEditor];
      await fake.callbacks.get('activeEditor')!(fake.secondEditor);
      await settleRuntime();
      expect(fake.executeCommand).toHaveBeenLastCalledWith(
        'setContext',
        'codexExtensionHelper.activeFileHasChanges',
        false,
      );

      fake.window.activeTextEditor = fake.editor;
      await fake.callbacks.get('activeEditor')!(fake.editor);
      await settleRuntime();
      expect(fake.executeCommand).toHaveBeenLastCalledWith(
        'setContext',
        'codexExtensionHelper.activeFileHasChanges',
        true,
      );

      fake.callbacks.get('watcherDelete')!(fake.uri);
      await settleRuntime();
      expect(fake.executeCommand).toHaveBeenLastCalledWith(
        'setContext',
        'codexExtensionHelper.activeFileHasChanges',
        false,
      );

      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses one presentation transition for external comparison and real approve/reject commands', async () => {
    vi.useFakeTimers();
    try {
      const baseline = 'one\nkeep\ntwo\n';
      const modified = 'ONE\nkeep\nTWO\n';
      const fake = installRuntimeVscode(baseline);
      const { ExtensionRuntime } = await import('../../src/extension');
      const runtime = new ExtensionRuntime({
        enabled: true,
        debounceMs: 0,
        maxFileSizeBytes: 1024,
        exclude: [],
      }, fake.output as never, {
        renderingDisabled: false,
        warningShown: false,
      });
      const view = (runtime as unknown as {
        view: { render(key: string, hunks: readonly ChangeHunk[]): Promise<void> };
      }).view;
      const render = vi.spyOn(view, 'render');

      fake.setText(modified);
      fake.callbacks.get('watcherChange')!(fake.uri);
      await settleRuntime();

      expect(fake.output.appendLine.mock.calls).toEqual([]);
      expect(render).toHaveBeenCalledTimes(1);
      expect(fake.editor.setDecorations).toHaveBeenCalledTimes(3);
      expect(fake.quickDiffBaseline()).toBe(baseline);
      expect(runtime.renderedComparisonCount).toBe(1);

      const approveLenses = fake.codeLenses().filter(
        (lens) => lens.command?.command === 'codexExtensionHelper.approveHunk',
      );
      expect(approveLenses).toHaveLength(2);
      await fake.commands.get('codexExtensionHelper.approveHunk')!(
        ...approveLenses[0].command!.arguments!,
      );
      await settleRuntime();

      expect(render).toHaveBeenCalledTimes(2);
      expect(fake.editor.setDecorations).toHaveBeenCalledTimes(9);
      expect(fake.quickDiffBaseline()).toBe('ONE\nkeep\ntwo\n');

      fake.workspace.applyEdit.mockClear();
      const rejectLens = fake.codeLenses().find(
        (lens) => lens.command?.command === 'codexExtensionHelper.rejectHunk',
      );
      expect(rejectLens).toBeDefined();
      await fake.commands.get('codexExtensionHelper.rejectHunk')!(
        ...rejectLens!.command!.arguments!,
      );
      expect(runtime.comparisonCount).toBe(1);
      expect(fake.quickDiffBaseline()).toBe('ONE\nkeep\ntwo\n');
      await settleRuntime();

      expect(fake.currentText()).toBe('ONE\nkeep\ntwo\n');
      expect(fake.quickDiffBaseline()).toBeUndefined();
      expect(runtime.comparisonCount).toBe(0);
      expect(runtime.renderedComparisonCount).toBe(0);

      render.mockRestore();
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears review state when Reject All emits two separated content changes', async () => {
    vi.useFakeTimers();
    try {
      const baseline = 'aa11bb22cc';
      const modified = 'aaXXbbYYcc';
      const fake = installRuntimeVscode(baseline);
      const { ExtensionRuntime } = await import('../../src/extension');
      const runtime = new ExtensionRuntime({
        enabled: true,
        debounceMs: 0,
        maxFileSizeBytes: 1024,
        exclude: [],
      }, fake.output as never, {
        renderingDisabled: false,
        warningShown: false,
      });

      fake.setText(modified);
      fake.callbacks.get('watcherChange')!(fake.uri);
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(runtime.comparisonCount).toBe(1);

      await fake.commands.get('codexExtensionHelper.rejectAll')!(fake.uri);
      await vi.runAllTimersAsync();
      await Promise.resolve();

      expect(fake.currentText()).toBe(baseline);
      expect(runtime.comparisonCount).toBe(0);
      expect(runtime.renderedComparisonCount).toBe(0);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the real presentation once for save and delete', async () => {
    vi.useFakeTimers();
    try {
      const { ExtensionRuntime } = await import('../../src/extension');
      const setup = async () => {
        const fake = installRuntimeVscode('before\n');
        const runtime = new ExtensionRuntime({
          enabled: true,
          debounceMs: 0,
          maxFileSizeBytes: 1024,
          exclude: [],
        }, fake.output as never, {
          renderingDisabled: false,
          warningShown: false,
        });
        fake.setText('after\n');
        fake.callbacks.get('watcherChange')!(fake.uri);
        await settleRuntime();
        const view = (runtime as unknown as { view: { clear(key: string): void } }).view;
        return { fake, runtime, clear: vi.spyOn(view, 'clear') };
      };

      const saved = await setup();
      saved.fake.callbacks.get('documentSave')!(saved.fake.document);
      await settleRuntime();
      expect(saved.clear).toHaveBeenCalledTimes(1);
      saved.clear.mockRestore();
      saved.runtime.dispose();

      const deleted = await setup();
      deleted.fake.callbacks.get('watcherDelete')!(deleted.fake.uri);
      await settleRuntime();
      expect(deleted.clear).toHaveBeenCalledTimes(1);
      deleted.clear.mockRestore();
      deleted.runtime.dispose();

    } finally {
      vi.useRealTimers();
    }
  });

  it('routes visible-editor show and an ineligible active editor through presentation synchronization', async () => {
    vi.useFakeTimers();
    try {
      const fake = installRuntimeVscode('before\n');
      const { ExtensionRuntime } = await import('../../src/extension');
      const runtime = new ExtensionRuntime({
        enabled: true,
        debounceMs: 0,
        maxFileSizeBytes: 1024,
        exclude: [],
      }, fake.output as never, {
        renderingDisabled: false,
        warningShown: false,
      });
      fake.setText('after\n');
      fake.callbacks.get('watcherChange')!(fake.uri);
      await settleRuntime();
      const view = (runtime as unknown as {
        view: { render(key: string, hunks: readonly ChangeHunk[]): Promise<void> };
      }).view;
      const render = vi.spyOn(view, 'render');

      fake.window.visibleTextEditors = [];
      fake.callbacks.get('visibleEditors')!([]);
      await settleRuntime();
      expect(render).toHaveBeenCalledTimes(1);
      expect(runtime.renderedComparisonCount).toBe(0);

      render.mockClear();
      fake.window.visibleTextEditors = [fake.editor];
      fake.callbacks.get('visibleEditors')!([fake.editor]);
      await settleRuntime();
      expect(render).toHaveBeenCalledTimes(1);
      expect(runtime.renderedComparisonCount).toBe(1);

      render.mockClear();
      const untitledEditor = {
        ...fake.editor,
        document: {
          ...fake.document,
          uri: { ...fake.uri, scheme: 'untitled', toString: () => 'untitled:review' },
        },
      };
      fake.window.activeTextEditor = untitledEditor as never;
      fake.callbacks.get('activeEditor')!(untitledEditor);
      await settleRuntime();
      expect(render).not.toHaveBeenCalled();
      expect(fake.executeCommand).toHaveBeenLastCalledWith(
        'setContext',
        'codexExtensionHelper.activeFileHasChanges',
        false,
      );

      render.mockRestore();
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears through the presentation boundary once on settings disable and not again on controller disposal', async () => {
    vi.useFakeTimers();
    try {
      const fake = installRuntimeVscode('before\n');
      const { ExtensionController } = await import('../../src/extension');
      const controller = new ExtensionController(fake.output as never);
      controller.start();
      await settleRuntime();
      const runtime = (controller as unknown as {
        runtime: { view: { clearAll(): void } };
      }).runtime;
      fake.setText('after\n');
      fake.callbacks.get('watcherChange')!(fake.uri);
      await vi.runAllTimersAsync();
      await Promise.resolve();
      const clearAll = vi.spyOn(runtime.view, 'clearAll');

      fake.setEnabled(false);
      fake.callbacks.get('configuration')!({
        affectsConfiguration: () => true,
      });
      await settleRuntime();
      expect(clearAll).toHaveBeenCalledTimes(1);

      await controller.shutdown();
      expect(clearAll).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
