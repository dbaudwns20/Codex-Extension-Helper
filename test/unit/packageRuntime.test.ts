import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
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

function installRuntimeVscode() {
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
  let text = 'before\n';
  let version = 1;
  const document = {
    uri,
    isDirty: false,
    lineCount: 2,
    eol: 1,
    get version() {
      return version;
    },
    getText: () => text,
    positionAt: (offset: number) => ({ offset }),
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
    onDidChangeVisibleTextEditors: event('visibleEditors'),
    onDidChangeActiveTextEditor: event('activeEditor'),
  };
  const workspace = {
    textDocuments: [document] as Array<typeof document | typeof secondDocument>,
    fs: {
      readFile: vi.fn(async () => new TextEncoder().encode(text)),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    applyEdit: vi.fn().mockResolvedValue(true),
    createFileSystemWatcher: vi.fn(() => watcher),
    registerTextDocumentContentProvider: vi.fn(() => disposable()),
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
  Object.assign(vscodeMock, {
    window,
    workspace,
    languages: { registerCodeLensProvider: vi.fn(() => disposable()) },
    scm: { createSourceControl: vi.fn(() => sourceControl) },
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
    Selection: FakeSelection,
    ThemeColor: FakeThemeColor,
    TabInputText: FakeTabInputText,
    DecorationRangeBehavior: { ClosedClosed: 1 },
    OverviewRulerLane: { Full: 7 },
    TextEditorRevealType: { InCenter: 9 },
  });

  return {
    callbacks,
    commands,
    document,
    editor,
    executeCommand,
    output: { appendLine: vi.fn() },
    secondDocument,
    secondEditor,
    setText(value: string) {
      text = value;
      version += 1;
    },
    uri,
    window,
    workspace,
  };
}

describe('packaged runtime', () => {
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

  it('lists the bundled entry as the only packaged runtime JavaScript', () => {
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
    expect(
      result.stdout
        .split(/\r?\n/u)
        .filter((entry) => entry.startsWith('out/src/') && entry.endsWith('.js')),
    ).toEqual(['out/src/extension.js']);
  });
});

describe('stable review runtime boundaries', () => {
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
      { line: 7, character: 0 },
      { line: 7, character: 0 },
    ));
    expect(editor.revealRange).toHaveBeenCalledWith(
      new FakeRange(7, 0, 7, 0),
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

    expect(views.renderer.render).toHaveBeenCalledWith(key, state.hunks);
    expect(views.deletedLines.update).toHaveBeenCalledWith({
      key,
      sourceRevision: 9,
      currentText: 'live document\n',
      hunks: state.hunks,
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
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(fake.executeCommand).toHaveBeenLastCalledWith(
        'setContext',
        'codexExtensionHelper.activeFileHasChanges',
        true,
      );

      fake.workspace.textDocuments.push(fake.secondDocument);
      fake.window.activeTextEditor = fake.secondEditor;
      fake.window.visibleTextEditors = [fake.editor, fake.secondEditor];
      await fake.callbacks.get('activeEditor')!(fake.secondEditor);
      await Promise.resolve();
      expect(fake.executeCommand).toHaveBeenLastCalledWith(
        'setContext',
        'codexExtensionHelper.activeFileHasChanges',
        false,
      );

      fake.window.activeTextEditor = fake.editor;
      await fake.callbacks.get('activeEditor')!(fake.editor);
      await Promise.resolve();
      expect(fake.executeCommand).toHaveBeenLastCalledWith(
        'setContext',
        'codexExtensionHelper.activeFileHasChanges',
        true,
      );

      fake.callbacks.get('watcherDelete')!(fake.uri);
      await Promise.resolve();
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
});
