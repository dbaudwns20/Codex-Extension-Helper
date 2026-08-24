import { describe, expect, it } from 'vitest';
import manifest from '../../package.json';

describe('extension manifest', () => {
  it('targets Stable without a proposed API', () => {
    expect(manifest.engines.vscode).toBe('^1.105.0');
    expect(manifest).not.toHaveProperty('enabledApiProposals');
    expect(manifest.activationEvents).toContain('onStartupFinished');
  });

  it('declares the documented defaults', () => {
    const properties = manifest.contributes.configuration.properties;
    expect(properties['codexExtensionHelper.enabled'].default).toBe(true);
    expect(properties['codexExtensionHelper.debounceMs'].default).toBe(300);
    expect(properties['codexExtensionHelper.maxFileSizeKb'].default).toBe(1024);
  });

  it('publishes the same debounce range enforced by runtime normalization', () => {
    const debounce = manifest.contributes.configuration.properties[
      'codexExtensionHelper.debounceMs'
    ] as { minimum?: number; maximum?: number };

    expect(debounce.minimum).toBe(50);
    expect(debounce.maximum).toBe(5000);
  });
});
