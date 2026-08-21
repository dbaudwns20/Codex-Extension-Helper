import { describe, expect, it, vi } from 'vitest';
import {
  buildDeletedLinesHtml,
  escapeHtml,
  InlineRenderer,
  insetPlacementForHunk,
} from '../../src/inlineRenderer';
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

function fakeUri(value: string): FakeUri {
  return { toString: () => value };
}

function tabGroup(viewColumn: number, input: unknown) {
  return {
    viewColumn,
    activeTab: { input },
    isActive: true,
    tabs: [],
  };
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

  it('uses a nonce-free strict CSP without enabling scripts', () => {
    const html = buildDeletedLinesHtml(['old'], 0);

    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">`,
    );
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toContain('nonce=');
  });

  it('preserves tabs and uses the editor tab-size setting', () => {
    const html = buildDeletedLinesHtml(['\tindented'], 0);

    expect(html).toContain('\tindented');
    expect(html).toContain('white-space: pre');
    expect(html).toContain('tab-size: var(--vscode-editor-tabSize, 4)');
  });

  it('labels deleted lines with one-based original line numbers', () => {
    const html = buildDeletedLinesHtml(['first', 'second'], 4);

    expect(html).toContain('>5</span>');
    expect(html).toContain('>6</span>');
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

  it('reports rendering only after editor resources are successfully installed', async () => {
    const key = 'file:///test.ts';
    const editor = {
      viewColumn: 1,
      document: {
        lineCount: 1,
        uri: { toString: () => key },
      },
      setDecorations: vi.fn(),
    };
    const api = {
      window: {
        visibleTextEditors: [editor],
        tabGroups: { all: [tabGroup(1, new FakeTabInputText(fakeUri(key)))] },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
        createWebviewTextEditorInset: () => ({
          dispose: vi.fn(),
          webview: { html: '' },
        }),
        showWarningMessage: vi.fn().mockResolvedValue(undefined),
      },
      Range: class {},
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const renderer = new InlineRenderer(api as never, { appendLine: vi.fn() });

    expect(renderedStatus(renderer, key)).toBe(false);
    await renderer.render(key, [hunk()]);
    expect(renderedStatus(renderer, key)).toBe(true);

    renderer.clear(key);
    expect(renderedStatus(renderer, key)).toBe(false);
  });

  it('disposes a newly created inset when assigning its HTML fails', async () => {
    const insetDispose = vi.fn();
    const warning = vi.fn().mockResolvedValue(undefined);
    const htmlFailure = new Error('webview rejected HTML');
    const webview = Object.defineProperty({}, 'html', {
      set: () => { throw htmlFailure; },
    });
    const editor = {
      viewColumn: 1,
      document: {
        lineCount: 1,
        uri: { toString: () => 'file:///test.ts' },
      },
      setDecorations: vi.fn(),
    };
    const api = {
      window: {
        visibleTextEditors: [editor],
        tabGroups: {
          all: [tabGroup(1, new FakeTabInputText(fakeUri('file:///test.ts')))],
        },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
        createWebviewTextEditorInset: () => ({
          dispose: insetDispose,
          webview,
        }),
        showWarningMessage: warning,
      },
      Range: class {},
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const output = { appendLine: vi.fn() };
    const renderer = new InlineRenderer(api as never, output);

    await renderer.render('file:///test.ts', [hunk()]);
    await renderer.render('file:///test.ts', [hunk()]);

    expect(renderedStatus(renderer, 'file:///test.ts')).toBe(false);
    expect(insetDispose).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining(htmlFailure.message));
  });

  it('renders a normal editor while skipping both sides of a diff editor for the same URI', async () => {
    const key = 'file:///test.ts';
    const normalEditor = {
      viewColumn: 1,
      document: { lineCount: 1, uri: fakeUri(key) },
      setDecorations: vi.fn(),
    };
    const diffEditor = {
      viewColumn: 2,
      document: { lineCount: 1, uri: fakeUri(key) },
      setDecorations: vi.fn(),
    };
    const createInset = vi.fn(() => ({ dispose: vi.fn(), webview: { html: '' } }));
    const api = {
      window: {
        visibleTextEditors: [normalEditor, diffEditor],
        tabGroups: {
          all: [
            tabGroup(1, new FakeTabInputText(fakeUri(key))),
            tabGroup(2, new FakeTabInputTextDiff(fakeUri('file:///before.ts'), fakeUri(key))),
          ],
        },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
        createWebviewTextEditorInset: createInset,
        showWarningMessage: vi.fn().mockResolvedValue(undefined),
      },
      Range: class {},
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const renderer = new InlineRenderer(api as never, { appendLine: vi.fn() });

    await renderer.render(key, [hunk()]);

    expect(normalEditor.setDecorations).toHaveBeenCalledOnce();
    expect(diffEditor.setDecorations).not.toHaveBeenCalled();
    expect(createInset).toHaveBeenCalledOnce();
    expect(createInset).toHaveBeenCalledWith(normalEditor, -1, 1, { enableScripts: false });
  });

  it('skips unsupported custom tab inputs entirely', async () => {
    const key = 'file:///custom.ts';
    const editor = {
      viewColumn: 1,
      document: { lineCount: 1, uri: fakeUri(key) },
      setDecorations: vi.fn(),
    };
    const createInset = vi.fn(() => ({ dispose: vi.fn(), webview: { html: '' } }));
    const api = {
      window: {
        visibleTextEditors: [editor],
        tabGroups: { all: [tabGroup(1, { uri: fakeUri(key), viewType: 'custom' })] },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
        createWebviewTextEditorInset: createInset,
        showWarningMessage: vi.fn().mockResolvedValue(undefined),
      },
      Range: class {},
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const renderer = new InlineRenderer(api as never, { appendLine: vi.fn() });

    await renderer.render(key, [hunk()]);

    expect(editor.setDecorations).not.toHaveBeenCalled();
    expect(createInset).not.toHaveBeenCalled();
    expect(renderedStatus(renderer, key)).toBe(false);
  });

  it('disposes the previous inset before installing a rerender', async () => {
    const key = 'file:///rerender.ts';
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const editor = {
      viewColumn: 1,
      document: { lineCount: 1, uri: fakeUri(key) },
      setDecorations: vi.fn(),
    };
    const createInset = vi.fn()
      .mockReturnValueOnce({ dispose: firstDispose, webview: { html: '' } })
      .mockReturnValueOnce({ dispose: secondDispose, webview: { html: '' } });
    const api = {
      window: {
        visibleTextEditors: [editor],
        tabGroups: { all: [tabGroup(1, new FakeTabInputText(fakeUri(key)))] },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
        createWebviewTextEditorInset: createInset,
        showWarningMessage: vi.fn().mockResolvedValue(undefined),
      },
      Range: class {},
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const renderer = new InlineRenderer(api as never, { appendLine: vi.fn() });

    await renderer.render(key, [hunk()]);
    await renderer.render(key, [hunk()]);

    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).not.toHaveBeenCalled();
    expect(createInset).toHaveBeenCalledTimes(2);
  });

  it('continues clearing later resources when a decoration or inset disposer throws', async () => {
    const key = 'file:///throwing-cleanup.ts';
    const decorationFailure = new Error('decoration cleanup failed');
    const insetFailure = new Error('first inset cleanup failed');
    const secondInsetDispose = vi.fn();
    const editor = {
      viewColumn: 1,
      document: { lineCount: 3, uri: fakeUri(key) },
      setDecorations: vi.fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => { throw decorationFailure; }),
    };
    const createInset = vi.fn()
      .mockReturnValueOnce({
        dispose: vi.fn(() => { throw insetFailure; }),
        webview: { html: '' },
      })
      .mockReturnValueOnce({ dispose: secondInsetDispose, webview: { html: '' } });
    const api = {
      window: {
        visibleTextEditors: [editor],
        tabGroups: { all: [tabGroup(1, new FakeTabInputText(fakeUri(key)))] },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
        createWebviewTextEditorInset: createInset,
        showWarningMessage: vi.fn().mockResolvedValue(undefined),
      },
      Range: class {},
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const output = { appendLine: vi.fn() };
    const renderer = new InlineRenderer(api as never, output);
    const twoDeletions = [
      hunk(),
      hunk({ originalStart: 2, originalEnd: 3, modifiedStart: 2, modifiedEnd: 2 }),
    ];

    await renderer.render(key, twoDeletions);
    expect(() => renderer.clear(key)).not.toThrow();

    expect(secondInsetDispose).toHaveBeenCalledOnce();
    expect(renderedStatus(renderer, key)).toBe(false);
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining(decorationFailure.message));
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining(insetFailure.message));
  });

  it('preserves a later-editor render failure while cleanup failures are logged', async () => {
    const key = 'file:///later-editor.ts';
    const primaryFailure = new Error('later editor inset failed');
    const cleanupFailure = new Error('earlier inset cleanup failed');
    const firstEditor = {
      viewColumn: 1,
      document: { lineCount: 1, uri: fakeUri(key) },
      setDecorations: vi.fn(),
    };
    const secondEditor = {
      viewColumn: 2,
      document: { lineCount: 1, uri: fakeUri(key) },
      setDecorations: vi.fn(),
    };
    const createInset = vi.fn()
      .mockReturnValueOnce({
        dispose: vi.fn(() => { throw cleanupFailure; }),
        webview: { html: '' },
      })
      .mockImplementationOnce(() => { throw primaryFailure; });
    const warning = vi.fn().mockResolvedValue(undefined);
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
        createWebviewTextEditorInset: createInset,
        showWarningMessage: warning,
      },
      Range: class {},
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const output = { appendLine: vi.fn() };
    const renderer = new InlineRenderer(api as never, output);

    await expect(renderer.render(key, [hunk()])).resolves.toBeUndefined();

    expect(firstEditor.setDecorations).toHaveBeenCalledTimes(2);
    expect(secondEditor.setDecorations).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledOnce();
    expect(renderedStatus(renderer, key)).toBe(false);
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining(primaryFailure.message));
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining(cleanupFailure.message));
  });

  it('warns once when applying decorations fails and cleanup also throws', async () => {
    const key = 'file:///decoration-failure.ts';
    const primaryFailure = new Error('decoration apply failed');
    const cleanupFailure = new Error('decoration clear failed');
    const editor = {
      viewColumn: 1,
      document: { lineCount: 1, uri: fakeUri(key) },
      setDecorations: vi.fn()
        .mockImplementationOnce(() => { throw primaryFailure; })
        .mockImplementationOnce(() => { throw cleanupFailure; }),
    };
    const warning = vi.fn().mockResolvedValue(undefined);
    const api = {
      window: {
        visibleTextEditors: [editor],
        tabGroups: { all: [tabGroup(1, new FakeTabInputText(fakeUri(key)))] },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
        createWebviewTextEditorInset: vi.fn(),
        showWarningMessage: warning,
      },
      Range: class {},
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const output = { appendLine: vi.fn() };
    const renderer = new InlineRenderer(api as never, output);

    await expect(renderer.render(key, [hunk()])).resolves.toBeUndefined();

    expect(editor.setDecorations).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledOnce();
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining(primaryFailure.message));
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining(cleanupFailure.message));
  });

  it('disables and warns during construction when the proposed API is unavailable', () => {
    const warning = vi.fn().mockResolvedValue(undefined);
    const session = { renderingDisabled: false, warningShown: false };
    const api = {
      window: {
        visibleTextEditors: [],
        tabGroups: { all: [] },
        createTextEditorDecorationType: () => ({ dispose: vi.fn() }),
        showWarningMessage: warning,
      },
      Range: class {},
      ThemeColor: class {},
      DecorationRangeBehavior: { ClosedClosed: 0 },
      OverviewRulerLane: { Full: 7 },
      TabInputText: FakeTabInputText,
    };
    const output = { appendLine: vi.fn() };

    new InlineRenderer(api as never, output, undefined, session);
    new InlineRenderer(api as never, output, undefined, session);

    expect(warning).toHaveBeenCalledOnce();
    expect(output.appendLine).toHaveBeenCalledOnce();
    expect(session).toEqual({ renderingDisabled: true, warningShown: true });
  });
});
