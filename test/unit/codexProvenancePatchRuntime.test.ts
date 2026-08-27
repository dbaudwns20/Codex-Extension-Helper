import { describe, expect, it, vi } from 'vitest';

interface FakeCodexExtension {
  readonly extensionPath: string;
  readonly packageJSON?: { readonly version?: unknown };
}

function vscodeApi(extension: FakeCodexExtension | null = {
  extensionPath: '/extensions/openai.chatgpt-current',
  packageJSON: { version: '26.826.11250' },
}) {
  return {
    extensions: {
      getExtension: vi.fn((id: string) => (
        id === 'openai.chatgpt' ? extension ?? undefined : undefined
      )),
    },
    window: {
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
    },
    commands: { executeCommand: vi.fn() },
  };
}

describe('VS Code Codex provenance bridge runtime adapter', () => {
  it('uses the installed openai.chatgpt path for inspect, apply, and restore', async () => {
    const { createCodexProvenancePatchRuntimeDependencies } = await import(
      '../../src/codexProvenancePatchRuntime'
    );
    const calls: string[] = [];
    const installation = {
      inspectCodexProvenancePatch: vi.fn(async ({ extensionDir }: { extensionDir: string }) => {
        calls.push(`inspect:${extensionDir}`);
        return { status: 'patched', extensionVersion: '26.826.11250' };
      }),
      applyCodexProvenancePatch: vi.fn(async ({ extensionDir }: { extensionDir: string }) => {
        calls.push(`apply:${extensionDir}`);
        return { status: 'already-patched', extensionVersion: '26.826.11250' };
      }),
      restoreCodexProvenancePatch: vi.fn(async ({ extensionDir }: { extensionDir: string }) => {
        calls.push(`restore:${extensionDir}`);
        return { status: 'restored', extensionVersion: '26.826.11250' };
      }),
    };
    const api = vscodeApi();
    const runtime = createCodexProvenancePatchRuntimeDependencies(
      api,
      { appendLine: vi.fn() },
      async () => installation,
    );

    await expect(runtime.inspect()).resolves.toEqual({
      kind: 'patched',
      extensionVersion: '26.826.11250',
    });
    await runtime.apply();
    await runtime.restore();

    expect(calls).toEqual([
      'inspect:/extensions/openai.chatgpt-current',
      'apply:/extensions/openai.chatgpt-current',
      'restore:/extensions/openai.chatgpt-current',
    ]);
  });

  it('reports a missing Codex installation without loading the installer', async () => {
    const { createCodexProvenancePatchRuntimeDependencies } = await import(
      '../../src/codexProvenancePatchRuntime'
    );
    const api = vscodeApi(null);
    const loadModule = vi.fn();
    const runtime = createCodexProvenancePatchRuntimeDependencies(
      api,
      { appendLine: vi.fn() },
      loadModule,
    );

    await expect(runtime.inspect()).resolves.toEqual({ kind: 'missing' });
    expect(loadModule).not.toHaveBeenCalled();
  });

  it('turns tamper and partial-state inspection failures into an actionable invalid status', async () => {
    const { createCodexProvenancePatchRuntimeDependencies } = await import(
      '../../src/codexProvenancePatchRuntime'
    );
    const api = vscodeApi();
    const runtime = createCodexProvenancePatchRuntimeDependencies(
      api,
      { appendLine: vi.fn() },
      async () => ({
        inspectCodexProvenancePatch: async () => {
          throw new Error('Current Codex provenance target hash does not match patch metadata');
        },
        applyCodexProvenancePatch: vi.fn(),
        restoreCodexProvenancePatch: vi.fn(),
      }),
    );

    await expect(runtime.inspect()).resolves.toEqual({
      kind: 'invalid',
      extensionVersion: '26.826.11250',
      message: 'Current Codex provenance target hash does not match patch metadata',
    });
  });

  it('treats unknown installer status as invalid rather than guessing', async () => {
    const { createCodexProvenancePatchRuntimeDependencies } = await import(
      '../../src/codexProvenancePatchRuntime'
    );
    const api = vscodeApi();
    const runtime = createCodexProvenancePatchRuntimeDependencies(
      api,
      { appendLine: vi.fn() },
      async () => ({
        inspectCodexProvenancePatch: async () => ({
          status: 'restored-pending-cleanup',
          extensionVersion: '26.826.11250',
        }),
        applyCodexProvenancePatch: vi.fn(),
        restoreCodexProvenancePatch: vi.fn(),
      }),
    );

    await expect(runtime.inspect()).resolves.toEqual({
      kind: 'invalid',
      extensionVersion: '26.826.11250',
      message: 'Unknown provenance bridge state: restored-pending-cleanup',
    });
  });

  it('uses modal mutation confirmation and a separate post-success reload prompt', async () => {
    const { createCodexProvenancePatchRuntimeDependencies } = await import(
      '../../src/codexProvenancePatchRuntime'
    );
    const api = vscodeApi();
    api.window.showWarningMessage.mockResolvedValue('Install Bridge');
    api.window.showInformationMessage.mockResolvedValue('Reload VS Code');
    const runtime = createCodexProvenancePatchRuntimeDependencies(
      api,
      { appendLine: vi.fn() },
      vi.fn(),
    );

    await expect(runtime.confirm('Modify Codex?', 'Install Bridge')).resolves.toBe(
      'Install Bridge',
    );
    await expect(runtime.offerReload('Installed.', 'Reload VS Code')).resolves.toBe(
      'Reload VS Code',
    );
    await runtime.reload();

    expect(api.window.showWarningMessage).toHaveBeenCalledWith(
      'Modify Codex?',
      { modal: true },
      'Install Bridge',
    );
    expect(api.window.showInformationMessage).toHaveBeenCalledWith(
      'Installed.',
      'Reload VS Code',
    );
    expect(api.commands.executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
  });
});
