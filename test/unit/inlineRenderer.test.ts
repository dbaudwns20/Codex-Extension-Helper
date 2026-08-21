import { describe, expect, it, vi } from 'vitest';
import {
  buildDeletedLinesHtml,
  escapeHtml,
  InlineRenderer,
  insetPlacementForHunk,
} from '../../src/inlineRenderer';
import type { ChangeHunk } from '../../src/types';

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

  it('disposes a newly created inset when assigning its HTML fails', async () => {
    const insetDispose = vi.fn();
    const warning = vi.fn().mockResolvedValue(undefined);
    const htmlFailure = new Error('webview rejected HTML');
    const webview = Object.defineProperty({}, 'html', {
      set: () => { throw htmlFailure; },
    });
    const editor = {
      document: {
        lineCount: 1,
        uri: { toString: () => 'file:///test.ts' },
      },
      setDecorations: vi.fn(),
    };
    const api = {
      window: {
        visibleTextEditors: [editor],
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
    };
    const output = { appendLine: vi.fn() };
    const renderer = new InlineRenderer(api as never, output);

    await renderer.render('file:///test.ts', [hunk()]);
    await renderer.render('file:///test.ts', [hunk()]);

    expect(insetDispose).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining(htmlFailure.message));
  });
});
