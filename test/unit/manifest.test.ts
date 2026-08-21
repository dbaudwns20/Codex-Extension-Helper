import { describe, expect, it } from 'vitest';
import manifest from '../../package.json';

describe('extension manifest', () => {
  it('targets Insiders and enables only the required proposal', () => {
    expect(manifest.engines.vscode).toBe('^1.134.0');
    expect(manifest.enabledApiProposals).toEqual(['editorInsets']);
    expect(manifest.activationEvents).toContain('onStartupFinished');
  });

  it('declares the documented defaults', () => {
    const properties = manifest.contributes.configuration.properties;
    expect(properties['codexInlineChanges.enabled'].default).toBe(true);
    expect(properties['codexInlineChanges.debounceMs'].default).toBe(300);
    expect(properties['codexInlineChanges.maxFileSizeKb'].default).toBe(1024);
  });
});
