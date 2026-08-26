import { describe, expect, it, vi } from 'vitest';

describe('Codex drop patch runtime commands', () => {
  it('offers an unpatched Codex installation and applies it before reload', async () => {
    const runtimeModule = await import('../../src/codexDropPatchCommands') as unknown as {
      createCodexDropPatchController?: (dependencies: Record<string, unknown>) => {
        offerInstallIfNeeded(): Promise<string>;
      };
    };
    expect(typeof runtimeModule.createCodexDropPatchController).toBe('function');
    if (runtimeModule.createCodexDropPatchController === undefined) return;

    let patched = false;
    let reloadCount = 0;
    const controller = runtimeModule.createCodexDropPatchController({
      inspect: async () => ({
        kind: patched ? 'patched' : 'not-patched',
        extensionVersion: '26.820.60940',
      }),
      apply: async () => {
        patched = true;
        return { status: 'patched', extensionVersion: '26.820.60940' };
      },
      restore: vi.fn(),
      chooseInformation: async () => 'Apply and Reload',
      showInformation: vi.fn(),
      showError: vi.fn(),
      reload: async () => { reloadCount += 1; },
      log: vi.fn(),
    });

    const result = await controller.offerInstallIfNeeded();

    expect(result).toBe('patched');
    expect(patched).toBe(true);
    expect(reloadCount).toBe(1);
  });

  it('reports the installed Codex version and patch state', async () => {
    const { createCodexDropPatchController } = await import('../../src/codexDropPatchCommands');
    const messages: string[] = [];
    const controller = createCodexDropPatchController({
      inspect: async () => ({ kind: 'patched', extensionVersion: '26.820.60940' }),
      apply: vi.fn(),
      restore: vi.fn(),
      chooseInformation: vi.fn(),
      showInformation: async (message) => { messages.push(message); },
      showError: vi.fn(),
      reload: vi.fn(),
      log: vi.fn(),
    });

    await controller.showStatus();

    expect(messages).toEqual(['Codex 26.820.60940 Explorer drop @mention patch is installed.']);
  });

  it('restores an installed patch after confirmation and reloads', async () => {
    const { createCodexDropPatchController } = await import('../../src/codexDropPatchCommands');
    let patched = true;
    let reloadCount = 0;
    const controller = createCodexDropPatchController({
      inspect: async () => ({
        kind: patched ? 'patched' : 'not-patched',
        extensionVersion: '26.820.60940',
      }),
      apply: vi.fn(),
      restore: async () => {
        patched = false;
        return { status: 'restored', extensionVersion: '26.820.60940' };
      },
      chooseInformation: async () => 'Remove and Reload',
      showInformation: vi.fn(),
      showError: vi.fn(),
      reload: async () => { reloadCount += 1; },
      log: vi.fn(),
    });

    await controller.remove();

    expect(patched).toBe(false);
    expect(reloadCount).toBe(1);
  });

  it('explains why an explicit install command cannot patch missing or invalid Codex state', async () => {
    const { createCodexDropPatchController } = await import('../../src/codexDropPatchCommands');
    const information: string[] = [];
    const errors: string[] = [];
    let state: { kind: 'missing' } | { kind: 'invalid'; extensionVersion: string; message: string } = {
      kind: 'missing',
    };
    const controller = createCodexDropPatchController({
      inspect: async () => state,
      apply: vi.fn(),
      restore: vi.fn(),
      chooseInformation: vi.fn(),
      showInformation: async (message) => { information.push(message); },
      showError: async (message) => { errors.push(message); },
      reload: vi.fn(),
      log: vi.fn(),
    });

    await controller.install();
    state = { kind: 'invalid', extensionVersion: '26.820.60940', message: 'hash mismatch' };
    await controller.install();

    expect(information).toEqual(['The OpenAI Codex extension is not installed.']);
    expect(errors).toEqual(['Codex 26.820.60940 drop patch state is invalid: hash mismatch']);
  });

  it('allows a verified previous-version patch to be removed', async () => {
    const { createCodexDropPatchController } = await import('../../src/codexDropPatchCommands');
    const restore = vi.fn(async () => ({ status: 'restored', extensionVersion: '26.818.61809' }));
    const reload = vi.fn();
    const controller = createCodexDropPatchController({
      inspect: async () => ({ kind: 'legacy-patched', extensionVersion: '26.818.61809' }),
      apply: vi.fn(),
      restore,
      chooseInformation: async () => 'Remove and Reload',
      showInformation: vi.fn(),
      showError: vi.fn(),
      reload,
      log: vi.fn(),
    } as never);

    await controller.remove();

    expect(restore).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('reports clean and invalid states from an explicit remove command', async () => {
    const { createCodexDropPatchController } = await import('../../src/codexDropPatchCommands');
    const information: string[] = [];
    const errors: string[] = [];
    let state = { kind: 'not-patched', extensionVersion: '26.820.60940' } as const;
    const dependencies = {
      inspect: async () => state,
      apply: vi.fn(),
      restore: vi.fn(),
      chooseInformation: vi.fn(),
      showInformation: async (message: string) => { information.push(message); },
      showError: async (message: string) => { errors.push(message); },
      reload: vi.fn(),
      log: vi.fn(),
    };
    const controller = createCodexDropPatchController(dependencies);

    await controller.remove();
    (dependencies.inspect as unknown as { (): Promise<unknown> }) = async () => ({
      kind: 'invalid',
      extensionVersion: '26.820.60940',
      message: 'partial state',
    });
    await controller.remove();

    expect(information).toEqual(['Codex 26.820.60940 Explorer drop @mention patch is not installed.']);
    expect(errors).toEqual(['Codex 26.820.60940 drop patch state is invalid: partial state']);
  });
});
