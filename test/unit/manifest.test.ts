import { describe, expect, it } from 'vitest';
import manifest from '../../package.json';

describe('extension manifest', () => {
  it('targets Stable without a proposed API', () => {
    expect(manifest.engines.vscode).toBe('^1.105.0');
    expect(manifest).not.toHaveProperty('enabledApiProposals');
    expect(manifest.activationEvents).toContain('onStartupFinished');
  });

  it('points recipients to the packaged proprietary license', () => {
    expect(manifest.license).toBe('SEE LICENSE IN LICENSE');
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

  it('contributes every review command alongside the existing full diff command', () => {
    expect(manifest.contributes.commands.map(({ command }) => command)).toEqual([
      'codexExtensionHelper.openDiff',
      'codexExtensionHelper.approveHunk',
      'codexExtensionHelper.rejectHunk',
      'codexExtensionHelper.previousChange',
      'codexExtensionHelper.nextChange',
      'codexExtensionHelper.approveAll',
      'codexExtensionHelper.rejectAll',
      'codexExtensionHelper.insertExplorerPathIntoCodex',
    ]);
  });

  it('offers Codex @ mention insertion from the Explorer context menu on macOS', () => {
    expect(manifest.contributes.commands).toContainEqual(expect.objectContaining({
      command: 'codexExtensionHelper.insertExplorerPathIntoCodex',
      title: 'Codex: Add as @ Mention',
    }));
    expect(manifest.contributes.menus['explorer/context']).toEqual([
      {
        command: 'codexExtensionHelper.insertExplorerPathIntoCodex',
        when: 'resourceScheme == file && isMac',
        group: 'codex@1',
      },
    ]);
  });

  it('shows only active-file navigation and all-change actions in the editor title', () => {
    expect(manifest.contributes.menus['editor/title']).toEqual([
      {
        command: 'codexExtensionHelper.previousChange',
        when: 'resourceScheme == file && codexExtensionHelper.activeFileHasChanges',
        group: 'navigation@10',
      },
      {
        command: 'codexExtensionHelper.nextChange',
        when: 'resourceScheme == file && codexExtensionHelper.activeFileHasChanges',
        group: 'navigation@11',
      },
      {
        command: 'codexExtensionHelper.approveAll',
        when: 'resourceScheme == file && codexExtensionHelper.activeFileHasChanges',
        group: 'navigation@20',
      },
      {
        command: 'codexExtensionHelper.rejectAll',
        when: 'resourceScheme == file && codexExtensionHelper.activeFileHasChanges',
        group: 'navigation@21',
      },
    ]);

    expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: 'codexExtensionHelper.previousChange',
        icon: '$(arrow-up)',
      }),
      expect.objectContaining({
        command: 'codexExtensionHelper.nextChange',
        icon: '$(arrow-down)',
      }),
      expect.objectContaining({
        command: 'codexExtensionHelper.approveAll',
        icon: '$(check-all)',
      }),
      expect.objectContaining({
        command: 'codexExtensionHelper.rejectAll',
        icon: '$(discard)',
      }),
    ]));
  });
});
