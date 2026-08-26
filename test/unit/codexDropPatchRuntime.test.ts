import { describe, expect, it, vi } from 'vitest';

describe('VS Code Codex drop patch runtime adapter', () => {
  it('uses the installed openai.chatgpt extension path for inspection and mutation', async () => {
    const runtimeModule = await import('../../src/codexDropPatchRuntime') as unknown as {
      createCodexDropPatchRuntimeDependencies?: (...args: unknown[]) => {
        inspect(): Promise<unknown>;
        apply(): Promise<unknown>;
        restore(): Promise<unknown>;
      };
    };
    expect(typeof runtimeModule.createCodexDropPatchRuntimeDependencies).toBe('function');
    if (runtimeModule.createCodexDropPatchRuntimeDependencies === undefined) return;

    const calls: string[] = [];
    const patchModule = {
      inspectCodexDropPatch: vi.fn(async ({ extensionDir }: { extensionDir: string }) => {
        calls.push(`inspect:${extensionDir}`);
        return { status: 'patched', extensionVersion: '26.820.60940' };
      }),
      applyCodexDropPatch: vi.fn(async ({ extensionDir }: { extensionDir: string }) => {
        calls.push(`apply:${extensionDir}`);
        return { status: 'already-patched', extensionVersion: '26.820.60940' };
      }),
      restoreCodexDropPatch: vi.fn(async ({ extensionDir }: { extensionDir: string }) => {
        calls.push(`restore:${extensionDir}`);
        return { status: 'restored', extensionVersion: '26.820.60940' };
      }),
    };
    const api = {
      extensions: {
        getExtension: vi.fn((id: string) => (
          id === 'openai.chatgpt' ? { extensionPath: '/extensions/openai.chatgpt-current' } : undefined
        )),
      },
      window: {
        showInformationMessage: vi.fn(),
        showErrorMessage: vi.fn(),
      },
      commands: { executeCommand: vi.fn() },
    };
    const dependencies = runtimeModule.createCodexDropPatchRuntimeDependencies(
      api,
      { appendLine: vi.fn() },
      async () => patchModule,
    );

    await expect(dependencies.inspect()).resolves.toEqual({
      kind: 'patched',
      extensionVersion: '26.820.60940',
    });
    await dependencies.apply();
    await dependencies.restore();

    expect(calls).toEqual([
      'inspect:/extensions/openai.chatgpt-current',
      'apply:/extensions/openai.chatgpt-current',
      'restore:/extensions/openai.chatgpt-current',
    ]);
  });

  it('preserves a verified previous patch state for migration and removal', async () => {
    const { createCodexDropPatchRuntimeDependencies } = await import('../../src/codexDropPatchRuntime');
    const dependencies = createCodexDropPatchRuntimeDependencies({
      extensions: { getExtension: () => ({ extensionPath: '/extensions/openai.chatgpt-previous' }) },
      window: { showInformationMessage: vi.fn(), showErrorMessage: vi.fn() },
      commands: { executeCommand: vi.fn() },
    }, { appendLine: vi.fn() }, async () => ({
      inspectCodexDropPatch: async () => ({ status: 'legacy-patched', extensionVersion: '26.818.61809' }),
      applyCodexDropPatch: vi.fn(),
      restoreCodexDropPatch: vi.fn(),
    }));

    await expect(dependencies.inspect()).resolves.toEqual({
      kind: 'legacy-patched',
      extensionVersion: '26.818.61809',
    });
  });
});
