import type { ComparisonView } from './coordinator';
import type { ChangeHunk } from './types';

export interface RenderStatusView extends ComparisonView {
  hasRendered(key: string): boolean;
}

export class DiagnosticView implements ComparisonView {
  private readonly renderedKeys = new Set<string>();

  constructor(private readonly delegate: RenderStatusView) {}

  get renderedComparisonCount(): number {
    return this.renderedKeys.size;
  }

  async render(key: string, hunks: readonly ChangeHunk[]): Promise<void> {
    await this.delegate.render(key, hunks);
    if (hunks.length > 0 && this.delegate.hasRendered(key)) {
      this.renderedKeys.add(key);
    } else {
      this.renderedKeys.delete(key);
    }
  }

  clear(key: string): void {
    this.renderedKeys.delete(key);
    this.delegate.clear(key);
  }

  clearAll(): void {
    this.renderedKeys.clear();
    this.delegate.clearAll();
  }
}
