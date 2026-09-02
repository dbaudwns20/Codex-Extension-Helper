import { describe, expect, it } from 'vitest';
import manifest from '../../package.json';

describe('extension manifest', () => {
  it('targets Stable 1.135 with the editor inset proposal enabled', () => {
    expect(manifest.engines.vscode).toBe('^1.135.0');
    expect(manifest.enabledApiProposals).toEqual(['editorInsets']);
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
      'codexExtensionHelper.approveFile',
      'codexExtensionHelper.rejectFile',
      'codexExtensionHelper.approveAllFiles',
      'codexExtensionHelper.rejectAllFiles',
      'codexExtensionHelper.insertExplorerPathIntoCodex',
      'codexExtensionHelper.installCodexDropPatch',
      'codexExtensionHelper.removeCodexDropPatch',
      'codexExtensionHelper.showCodexDropPatchStatus',
      'codexExtensionHelper.installProvenanceBridge',
      'codexExtensionHelper.removeProvenanceBridge',
      'codexExtensionHelper.showProvenanceBridgeStatus',
    ]);
  });

  it('uses Accept terminology for every visible approval command', () => {
    const acceptanceTitles = manifest.contributes.commands
      .filter(({ command }) => command.includes('approve'))
      .map(({ title }) => title);

    expect(acceptanceTitles).toEqual([
      'Codex Changes: Accept Change',
      'Codex Changes: Accept All',
      'Accept File',
      'Accept All Files',
    ]);
  });

  it('exposes Codex drop patch management to VSIX recipients', () => {
    expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
      {
        command: 'codexExtensionHelper.installCodexDropPatch',
        title: 'Codex Helper: Install/Repair Drop Patch',
      },
      {
        command: 'codexExtensionHelper.removeCodexDropPatch',
        title: 'Codex Helper: Remove Drop Patch',
      },
      {
        command: 'codexExtensionHelper.showCodexDropPatchStatus',
        title: 'Codex Helper: Show Drop Patch Status',
      },
    ]));
  });

  it('exposes manual exact provenance bridge management and matching CLI scripts', () => {
    expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
      {
        command: 'codexExtensionHelper.installProvenanceBridge',
        title: 'Codex Helper: Install Exact Provenance Bridge',
      },
      {
        command: 'codexExtensionHelper.removeProvenanceBridge',
        title: 'Codex Helper: Remove Exact Provenance Bridge',
      },
      {
        command: 'codexExtensionHelper.showProvenanceBridgeStatus',
        title: 'Codex Helper: Show Exact Provenance Bridge Status',
      },
    ]));
    expect(manifest.scripts['patch:codex-provenance']).toBe(
      'node ./scripts/patch-codex-provenance.mjs',
    );
    expect(manifest.scripts['unpatch:codex-provenance']).toBe(
      'node ./scripts/unpatch-codex-provenance.mjs',
    );
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

  it('offers file actions and workspace-wide actions in Codex Changes', () => {
    expect(manifest.contributes.menus['scm/resourceState/context']).toEqual([
      {
        command: 'codexExtensionHelper.approveFile',
        when: 'scmProvider == codexChanges && scmResourceState == codexChange',
        group: 'inline@10',
      },
      {
        command: 'codexExtensionHelper.rejectFile',
        when: 'scmProvider == codexChanges && scmResourceState == codexChange',
        group: 'inline@11',
      },
    ]);
    expect(manifest.contributes.menus['scm/title']).toEqual([
      {
        command: 'codexExtensionHelper.approveAllFiles',
        when: 'scmProvider == codexChanges',
        group: 'navigation@10',
      },
      {
        command: 'codexExtensionHelper.rejectAllFiles',
        when: 'scmProvider == codexChanges',
        group: 'navigation@11',
      },
    ]);
  });
});
