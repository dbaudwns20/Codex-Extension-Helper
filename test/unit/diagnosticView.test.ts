import { describe, expect, it, vi } from 'vitest';
import {
  DiagnosticView,
  type RenderStatusView,
} from '../../src/diagnosticView';
import type { ChangeHunk } from '../../src/types';

const hunks: readonly ChangeHunk[] = [{
  kind: 'addition',
  originalStart: 0,
  originalEnd: 0,
  modifiedStart: 0,
  modifiedEnd: 1,
  originalLines: [],
  modifiedLines: ['new'],
}];

class FakeRenderStatusView implements RenderStatusView {
  rendered = false;
  readonly clear = vi.fn<(key: string) => void>();
  readonly clearAll = vi.fn<() => void>();
  readonly render = vi.fn(async () => undefined);

  hasRendered(): boolean {
    return this.rendered;
  }
}

describe('DiagnosticView', () => {
  it('does not count a normally-resolving renderer failure as rendered', async () => {
    const delegate = new FakeRenderStatusView();
    const view = new DiagnosticView(delegate);

    await view.render('file:///failed.ts', hunks);

    expect(view.renderedComparisonCount).toBe(0);
  });

  it('counts only confirmed renderer resources and removes cleared keys', async () => {
    const delegate = new FakeRenderStatusView();
    const view = new DiagnosticView(delegate);
    delegate.rendered = true;

    await view.render('file:///rendered.ts', hunks);
    expect(view.renderedComparisonCount).toBe(1);

    view.clear('file:///rendered.ts');
    expect(view.renderedComparisonCount).toBe(0);
    expect(delegate.clear).toHaveBeenCalledWith('file:///rendered.ts');
  });
});
