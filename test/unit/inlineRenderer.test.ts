import { describe, expect, it, vi } from 'vitest';
import {
  buildDeletedLinesHtml,
  escapeHtml,
  InlineRenderer,
  insetPlacementForHunk,
} from '../../src/inlineRenderer';
import { createTemporaryLineSpacerPlan } from '../../src/temporaryLineSpacers';
import type { ChangeHunk } from '../../src/types';

interface FakeUri {
  toString(): string;
}

class FakeTabInputText {
  constructor(readonly uri: FakeUri) {}
}

class FakeTabInputTextDiff {
  constructor(
    readonly original: FakeUri,
    readonly modified: FakeUri,
  ) {}
}

class FakeRange {
  constructor(
    readonly startLine: number,
    readonly startCharacter: number,
    readonly endLine: number,
    readonly endCharacter: number,
  ) {}
}

function fakeUri(value: string): FakeUri {
  return { toString: () => value };
}

function fakeDocument(key: string, lineCount = 1) {
  return {
    lineCount,
    uri: fakeUri(key),
    lineAt: (line: number) => ({ range: { end: { character: line + 1 } } }),
  };
}

function tabGroup(viewColumn: number, input: unknown) {
  return {
    viewColumn,
    activeTab: { input },
    isActive: true,
    tabs: [],
  };
}

function withEditorInsets<T>(api: T): T {
  const window = (api as { window: Record<string, unknown> }).window;
  window.createWebviewTextEditorInset ??= () => ({
    webview: { html: '' },
    dispose: vi.fn(),
  });
  window.showWarningMessage ??= vi.fn();
  return api;
}

function hunk(overrides: Partial<ChangeHunk> = {}): ChangeHunk {
  return {
    kind: 'deletion',
    originalStart: 0,
    originalEnd: 1,
    modifiedStart: 0,
    modifiedEnd: 0,
    originalLines: ['old'],
    modifiedLines: [],
    ...overrides,
  };
}

function renderedStatus(renderer: InlineRenderer, key: string): boolean | undefined {
  const candidate = renderer as InlineRenderer & {
    hasRendered?: (renderedKey: string) => boolean;
  };
  return candidate.hasRendered?.(key);
}

function deletedRenderingFixture(key: string, lineCount = 1) {
  const decorationTypes = [
    { name: 'added', dispose: vi.fn() },
    { name: 'removed-row', dispose: vi.fn() },
    { name: 'removed-overlay', dispose: vi.fn() },
  ];
  const editor = {
    viewColumn: 1,
    document: fakeDocument(key, lineCount),
    setDecorations: vi.fn(),
  };
  const api = {
    window: {
      visibleTextEditors: [editor],
      tabGroups: { all: [tabGroup(1, new FakeTabInputText(fakeUri(key)))] },
      createTextEditorDecorationType: vi.fn()
        .mockImplementationOnce(() => decorationTypes[0])
        .mockImplementationOnce(() => decorationTypes[1])
        .mockImplementationOnce(() => decorationTypes[2]),
    },
    Range: FakeRange,
    ThemeColor: class {},
    DecorationRangeBehavior: { ClosedClosed: 0 },
    OverviewRulerLane: { Full: 7 },
    TabInputText: FakeTabInputText,
  };
  return {
    decorationTypes,
    editor,
    renderer: new InlineRenderer(withEditorInsets(api) as never, { appendLine: vi.fn() }),
  };
}

describe('inline renderer helpers', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes document text before inserting it into a webview', () => {
    const html = buildDeletedLinesHtml(['<script>alert(1)</script>', 'a & b'], 4);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('a &amp; b');
  });

  it('renders deleted lines without embedding a second set of review controls', () => {
    const html = buildDeletedLinesHtml(['old'], 0);

    expect(html).toContain('<span class="code">old</span>');
    expect(html).not.toContain('class="actions"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<script');
  });

  it('preserves tabs and uses the editor tab-size setting', () => {
    const html = buildDeletedLinesHtml(['\tindented'], 0);

    expect(html).toContain('\tindented');
    expect(html).toContain('white-space: pre');
    expect(html).toContain('tab-size: var(--vscode-editor-tabSize, 4)');
  });

  it('renders deleted lines without a line-number gutter', () => {
    const html = buildDeletedLinesHtml(['first', 'second'], 4);

    expect(html).not.toContain('class="gutter"');
    expect(html).toContain('<span class="code">first</span>');
    expect(html).toContain('<span class="code">second</span>');
  });

  it('places original lines before a first-line replacement', () => {
    expect(insetPlacementForHunk(hunk({
      kind: 'modification',
      modifiedStart: 0,
      modifiedEnd: 1,
      modifiedLines: ['new'],
    }), 3)).toEqual({ anchorLine: -1, height: 1 });
  });

  it('places a pure deletion before the next surviving line', () => {
    expect(insetPlacementForHunk(hunk({ modifiedStart: 2, modifiedEnd: 2 }), 5))
      .toEqual({ anchorLine: 1, height: 1 });
  });

  it('places an EOF deletion after the final surviving line', () => {
    expect(insetPlacementForHunk(hunk({
      originalStart: 3,
      originalEnd: 5,
      originalLines: ['old four', 'old five'],
      modifiedStart: 3,
      modifiedEnd: 3,
    }), 3)).toEqual({ anchorLine: 2, height: 2 });
  });

  it('renders deleted lines in an editor inset without changing document text', async () => {
    const key = 'file:///inset.ts';
    const editor = {
      viewColumn: 1,
      document: fakeDocument(key, 3),
      setDecorations: vi.fn(),
    };
    const inset = { webview: { html: '' }, dispose: vi.fn() };
    const createInset = vi.fn(() => inset);
    const api = {
      window: {
        visibleTextEditors: [editor],
        tabGroups: { all: [tabGroup(1, new FakeTabInputText(fakeUri(key)))] },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
        createWebviewTextEditorInset: createInset,
        showWarningMessage: vi.fn(),
      },
      Range: FakeRange,
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const renderer = new InlineRenderer(withEditorInsets(api) as never, { appendLine: vi.fn() });

    await renderer.render(key, [hunk({
      originalEnd: 2,
      originalLines: ['first old line', 'second old line'],
    })]);

    expect(createInset).toHaveBeenCalledWith(editor, -1, 2);
    expect(inset.webview.html).toContain('first old line');
    expect(inset.webview.html).toContain('second old line');
    expect(editor.document.lineCount).toBe(3);
  });

  it('warns once and disables rendering when editor insets are unavailable', async () => {
    const key = 'file:///unsupported.ts';
    const editor = {
      viewColumn: 1,
      document: fakeDocument(key),
      setDecorations: vi.fn(),
    };
    const showWarningMessage = vi.fn();
    const sessionState = { renderingDisabled: false, warningShown: false };
    const api = {
      window: {
        visibleTextEditors: [editor],
        tabGroups: { all: [tabGroup(1, new FakeTabInputText(fakeUri(key)))] },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
        showWarningMessage,
      },
      Range: FakeRange,
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const renderer = new InlineRenderer(
      api as never,
      { appendLine: vi.fn() },
      (uri) => uri.toString(),
      sessionState,
    );

    await renderer.render(key, [hunk()]);
    await renderer.render(key, [hunk()]);

    expect(sessionState.renderingDisabled).toBe(true);
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(renderedStatus(renderer, key)).toBe(false);
  });

  it('reports rendering only after editor resources are successfully installed', async () => {
    const key = 'file:///test.ts';
    const editor = {
      viewColumn: 1,
      document: fakeDocument(key),
      setDecorations: vi.fn(),
    };
    const api = {
      window: {
        visibleTextEditors: [editor],
        tabGroups: { all: [tabGroup(1, new FakeTabInputText(fakeUri(key)))] },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
      },
      Range: class {},
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const renderer = new InlineRenderer(withEditorInsets(api) as never, { appendLine: vi.fn() });

    expect(renderedStatus(renderer, key)).toBe(false);
    await renderer.render(key, [hunk()]);
    expect(renderedStatus(renderer, key)).toBe(true);

    renderer.clear(key);
    expect(renderedStatus(renderer, key)).toBe(false);
  });

  it('logs a decoration install failure and does not report the editor as rendered', async () => {
    const decorationFailure = new Error('decoration install failed');
    const editor = {
      viewColumn: 1,
      document: fakeDocument('file:///test.ts'),
      setDecorations: vi.fn()
        .mockImplementationOnce(() => { throw decorationFailure; })
        .mockImplementationOnce(() => undefined),
    };
    const api = {
      window: {
        visibleTextEditors: [editor],
        tabGroups: {
          all: [tabGroup(1, new FakeTabInputText(fakeUri('file:///test.ts')))],
        },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
      },
      Range: FakeRange,
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const output = { appendLine: vi.fn() };
    const renderer = new InlineRenderer(withEditorInsets(api) as never, output);

    await renderer.render('file:///test.ts', [hunk({
      kind: 'modification',
      modifiedEnd: 1,
      modifiedLines: ['new'],
    })]);

    expect(renderedStatus(renderer, 'file:///test.ts')).toBe(false);
    expect(editor.setDecorations).toHaveBeenCalledTimes(4);
    expect(output.appendLine).toHaveBeenCalledWith(
      expect.stringContaining(decorationFailure.message),
    );
  });

  it('decorates a normal editor while skipping a diff editor for the same URI', async () => {
    const key = 'file:///test.ts';
    const decorationType = { dispose: vi.fn() };
    const normalEditor = {
      viewColumn: 1,
      document: fakeDocument(key),
      setDecorations: vi.fn(),
    };
    const diffEditor = {
      viewColumn: 2,
      document: fakeDocument(key),
      setDecorations: vi.fn(),
    };
    const api = {
      window: {
        visibleTextEditors: [normalEditor, diffEditor],
        tabGroups: {
          all: [
            tabGroup(1, new FakeTabInputText(fakeUri(key))),
            tabGroup(2, new FakeTabInputTextDiff(fakeUri('file:///before.ts'), fakeUri(key))),
          ],
        },
        createTextEditorDecorationType: () => decorationType,
      },
      Range: FakeRange,
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const renderer = new InlineRenderer(withEditorInsets(api) as never, { appendLine: vi.fn() });

    await renderer.render(key, [hunk({
      kind: 'modification',
      modifiedStart: 2,
      modifiedEnd: 4,
      modifiedLines: ['new', 'lines'],
    })]);

    expect(normalEditor.setDecorations).toHaveBeenCalledTimes(3);
    expect(normalEditor.setDecorations).toHaveBeenCalledWith(
      decorationType,
      [new FakeRange(2, 0, 3, 0)],
    );
    expect(diffEditor.setDecorations).not.toHaveBeenCalled();
  });

  it('renders temporary deleted rows without a diff prefix', async () => {
    const key = 'file:///deleted-rows.ts';
    const deletedHunk = hunk({
      originalEnd: 2,
      originalLines: ['first old line', 'second old line'],
    });
    const plan = createTemporaryLineSpacerPlan('survivor', '\n', [deletedHunk]);
    const { decorationTypes, editor, renderer } = deletedRenderingFixture(key, 3);

    await renderer.render(key, [deletedHunk], {
      key,
      canonicalText: 'survivor',
      displayText: plan.displayText,
      documentVersion: 1,
      revision: 1,
      plan,
    });

    expect(editor.setDecorations).toHaveBeenCalledWith(
      decorationTypes[1],
      expect.arrayContaining([
        expect.objectContaining({
          renderOptions: { after: expect.objectContaining({ contentText: 'first old line' }) },
        }),
      ]),
    );
  });

  it('keeps deleted decoration text within spacer rows before modified lines', async () => {
    const key = 'file:///modified-row-separation.ts';
    const modifiedHunk = hunk({
      kind: 'modification',
      originalEnd: 2,
      modifiedEnd: 1,
      originalLines: ['first old line', 'second old line'],
      modifiedLines: ['new line'],
    });
    const plan = createTemporaryLineSpacerPlan('new line', '\n', [modifiedHunk]);
    const { decorationTypes, editor, renderer } = deletedRenderingFixture(key, 3);

    await renderer.render(key, [modifiedHunk], {
      key,
      canonicalText: 'new line',
      displayText: plan.displayText,
      documentVersion: 1,
      revision: 1,
      plan,
    });

    expect(editor.setDecorations).toHaveBeenCalledWith(
      decorationTypes[1],
      expect.arrayContaining([
        expect.objectContaining({
          range: new FakeRange(1, 0, 1, 0),
          renderOptions: { after: expect.objectContaining({ contentText: 'second old line' }) },
        }),
      ]),
    );
    expect(editor.setDecorations).toHaveBeenCalledWith(
      decorationTypes[0],
      [new FakeRange(2, 0, 2, 0)],
    );
  });

  it('does not overlay fallback deleted content on a modified line', async () => {
    const key = 'file:///fallback-modification.ts';
    const { decorationTypes, editor, renderer } = deletedRenderingFixture(key);

    await renderer.render(key, [hunk({
      kind: 'modification',
      modifiedEnd: 1,
      originalLines: ['"version": "0.0.2",'],
      modifiedLines: ['"version": "0.0.3",'],
    })]);

    expect(editor.setDecorations).toHaveBeenCalledWith(
      decorationTypes[2],
      [],
    );
  });

  it('skips unsupported custom tab inputs entirely', async () => {
    const key = 'file:///custom.ts';
    const editor = {
      viewColumn: 1,
      document: fakeDocument(key),
      setDecorations: vi.fn(),
    };
    const api = {
      window: {
        visibleTextEditors: [editor],
        tabGroups: { all: [tabGroup(1, { uri: fakeUri(key), viewType: 'custom' })] },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
      },
      Range: class {},
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const renderer = new InlineRenderer(withEditorInsets(api) as never, { appendLine: vi.fn() });

    await renderer.render(key, [hunk()]);

    expect(editor.setDecorations).not.toHaveBeenCalled();
    expect(renderedStatus(renderer, key)).toBe(false);
  });

  it('clears previous decorations before installing a rerender', async () => {
    const key = 'file:///rerender.ts';
    const decorationType = { dispose: vi.fn() };
    const editor = {
      viewColumn: 1,
      document: fakeDocument(key),
      setDecorations: vi.fn(),
    };
    const api = {
      window: {
        visibleTextEditors: [editor],
        tabGroups: { all: [tabGroup(1, new FakeTabInputText(fakeUri(key)))] },
        createTextEditorDecorationType: () => decorationType,
      },
      Range: FakeRange,
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const renderer = new InlineRenderer(withEditorInsets(api) as never, { appendLine: vi.fn() });

    const changed = hunk({
      kind: 'addition',
      modifiedEnd: 1,
      modifiedLines: ['new'],
    });
    await renderer.render(key, [changed]);
    await renderer.render(key, [changed]);

    expect(editor.setDecorations).toHaveBeenCalledTimes(9);
    expect(editor.setDecorations).toHaveBeenNthCalledWith(
      1,
      decorationType,
      [new FakeRange(0, 0, 0, 0)],
    );
    expect(editor.setDecorations).toHaveBeenNthCalledWith(
      7,
      decorationType,
      [new FakeRange(0, 0, 0, 0)],
    );
  });

  it('continues clearing later editors when one decoration cleanup throws', async () => {
    const key = 'file:///throwing-cleanup.ts';
    const decorationFailure = new Error('decoration cleanup failed');
    const firstEditor = {
      viewColumn: 1,
      document: fakeDocument(key),
      setDecorations: vi.fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => { throw decorationFailure; }),
    };
    const secondEditor = {
      viewColumn: 2,
      document: fakeDocument(key),
      setDecorations: vi.fn(),
    };
    const api = {
      window: {
        visibleTextEditors: [firstEditor, secondEditor],
        tabGroups: { all: [
          tabGroup(1, new FakeTabInputText(fakeUri(key))),
          tabGroup(2, new FakeTabInputText(fakeUri(key))),
        ] },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
      },
      Range: FakeRange,
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const output = { appendLine: vi.fn() };
    const renderer = new InlineRenderer(withEditorInsets(api) as never, output);

    await renderer.render(key, [hunk({
      kind: 'addition',
      modifiedEnd: 1,
      modifiedLines: ['new'],
    })]);
    expect(() => renderer.clear(key)).not.toThrow();

    expect(firstEditor.setDecorations).toHaveBeenCalledTimes(6);
    expect(secondEditor.setDecorations).toHaveBeenCalledTimes(6);
    expect(secondEditor.setDecorations).toHaveBeenLastCalledWith(expect.anything(), []);
    expect(renderedStatus(renderer, key)).toBe(false);
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining(decorationFailure.message));
  });

  it('rolls back every editor after a later decoration install fails', async () => {
    const key = 'file:///later-editor.ts';
    const primaryFailure = new Error('later editor decoration failed');
    const cleanupFailure = new Error('earlier decoration cleanup failed');
    const firstEditor = {
      viewColumn: 1,
      document: fakeDocument(key),
      setDecorations: vi.fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => { throw cleanupFailure; }),
    };
    const secondEditor = {
      viewColumn: 2,
      document: fakeDocument(key),
      setDecorations: vi.fn()
        .mockImplementationOnce(() => { throw primaryFailure; })
        .mockImplementationOnce(() => undefined),
    };
    const api = {
      window: {
        visibleTextEditors: [firstEditor, secondEditor],
        tabGroups: {
          all: [
            tabGroup(1, new FakeTabInputText(fakeUri(key))),
            tabGroup(2, new FakeTabInputText(fakeUri(key))),
          ],
        },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
      },
      Range: FakeRange,
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const output = { appendLine: vi.fn() };
    const renderer = new InlineRenderer(withEditorInsets(api) as never, output);

    await expect(renderer.render(key, [hunk({
      kind: 'addition',
      modifiedEnd: 1,
      modifiedLines: ['new'],
    })])).resolves.toBeUndefined();

    expect(firstEditor.setDecorations).toHaveBeenCalledTimes(6);
    expect(secondEditor.setDecorations).toHaveBeenCalledTimes(4);
    expect(renderedStatus(renderer, key)).toBe(false);
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining(primaryFailure.message));
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining(cleanupFailure.message));
  });

  it('logs both the primary decoration failure and its cleanup failure', async () => {
    const key = 'file:///decoration-failure.ts';
    const primaryFailure = new Error('decoration apply failed');
    const cleanupFailure = new Error('decoration clear failed');
    const editor = {
      viewColumn: 1,
      document: fakeDocument(key),
      setDecorations: vi.fn()
        .mockImplementationOnce(() => { throw primaryFailure; })
        .mockImplementationOnce(() => { throw cleanupFailure; }),
    };
    const api = {
      window: {
        visibleTextEditors: [editor],
        tabGroups: { all: [tabGroup(1, new FakeTabInputText(fakeUri(key)))] },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
      },
      Range: FakeRange,
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const output = { appendLine: vi.fn() };
    const renderer = new InlineRenderer(withEditorInsets(api) as never, output);

    await expect(renderer.render(key, [hunk()])).resolves.toBeUndefined();

    expect(editor.setDecorations).toHaveBeenCalledTimes(4);
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining(primaryFailure.message));
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining(cleanupFailure.message));
  });

  it('disposes Stable decorations once and ignores renders after disposal', async () => {
    const key = 'file:///dispose.ts';
    const decorationFailure = new Error('decoration type cleanup failed');
    const decorationType = { dispose: vi.fn(() => { throw decorationFailure; }) };
    const editor = {
      viewColumn: 1,
      document: fakeDocument(key),
      setDecorations: vi.fn(),
    };
    const api = {
      window: {
        visibleTextEditors: [editor],
        tabGroups: { all: [tabGroup(1, new FakeTabInputText(fakeUri(key)))] },
        createTextEditorDecorationType: () => decorationType,
      },
      Range: FakeRange,
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const output = { appendLine: vi.fn() };
    const renderer = new InlineRenderer(withEditorInsets(api) as never, output);

    await renderer.render(key, [hunk({
      kind: 'addition',
      modifiedEnd: 1,
      modifiedLines: ['new'],
    })]);
    renderer.dispose();
    renderer.dispose();
    await renderer.render(key, [hunk()]);

    expect(editor.setDecorations).toHaveBeenCalledTimes(6);
    expect(editor.setDecorations).toHaveBeenLastCalledWith(decorationType, []);
    expect(decorationType.dispose).toHaveBeenCalledTimes(3);
    expect(renderedStatus(renderer, key)).toBe(false);
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining(decorationFailure.message));
  });
});
