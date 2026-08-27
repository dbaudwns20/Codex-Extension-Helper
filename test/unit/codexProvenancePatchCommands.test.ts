import { describe, expect, it, vi } from 'vitest';

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    inspect: vi.fn(async () => ({
      kind: 'not-patched' as const,
      extensionVersion: '26.826.11250',
    })),
    apply: vi.fn(async () => ({
      status: 'patched',
      extensionVersion: '26.826.11250',
    })),
    restore: vi.fn(async () => ({
      status: 'restored',
      extensionVersion: '26.826.11250',
    })),
    confirm: vi.fn(async (_message: string, action: string) => action),
    offerReload: vi.fn(async (_message: string, action: string) => action),
    showInformation: vi.fn(),
    showError: vi.fn(),
    reload: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

describe('Codex provenance bridge commands', () => {
  it('registers all three commands without inspecting or mutating Codex', async () => {
    const {
      createCodexProvenancePatchController,
      registerCodexProvenancePatchCommands,
    } = await import('../../src/codexProvenancePatchCommands');
    const runtime = dependencies();
    const controller = createCodexProvenancePatchController(runtime);
    const subscriptions: { dispose(): unknown }[] = [];
    const registrations: string[] = [];

    registerCodexProvenancePatchCommands(
      subscriptions,
      (command, _handler) => {
        registrations.push(command);
        return { dispose: vi.fn() };
      },
      controller,
    );

    expect(registrations).toEqual([
      'codexExtensionHelper.installProvenanceBridge',
      'codexExtensionHelper.removeProvenanceBridge',
      'codexExtensionHelper.showProvenanceBridgeStatus',
    ]);
    expect(subscriptions).toHaveLength(3);
    expect(runtime.inspect).not.toHaveBeenCalled();
    expect(runtime.apply).not.toHaveBeenCalled();
    expect(runtime.restore).not.toHaveBeenCalled();
  });

  it('does not install unless the user explicitly confirms the installed Codex mutation', async () => {
    const { createCodexProvenancePatchController } = await import(
      '../../src/codexProvenancePatchCommands'
    );
    const runtime = dependencies({ confirm: vi.fn(async () => undefined) });
    const controller = createCodexProvenancePatchController(runtime);

    await controller.install();

    expect(runtime.confirm).toHaveBeenCalledWith(
      expect.stringContaining('modify the installed Codex extension'),
      'Install Bridge',
    );
    expect(runtime.apply).not.toHaveBeenCalled();
    expect(runtime.offerReload).not.toHaveBeenCalled();
    expect(runtime.reload).not.toHaveBeenCalled();
  });

  it('offers and performs a reload only after a confirmed successful install', async () => {
    const { createCodexProvenancePatchController } = await import(
      '../../src/codexProvenancePatchCommands'
    );
    const runtime = dependencies();
    const controller = createCodexProvenancePatchController(runtime);

    await controller.install();

    expect(runtime.apply).toHaveBeenCalledOnce();
    expect(runtime.offerReload).toHaveBeenCalledWith(
      expect.stringContaining('installed for Codex 26.826.11250'),
      'Reload VS Code',
    );
    expect(runtime.reload).toHaveBeenCalledOnce();
  });

  it('reports an already-installed bridge without prompting or mutating Codex', async () => {
    const { createCodexProvenancePatchController } = await import(
      '../../src/codexProvenancePatchCommands'
    );
    const runtime = dependencies({
      inspect: vi.fn(async () => ({
        kind: 'patched' as const,
        extensionVersion: '26.826.11250',
      })),
    });
    const controller = createCodexProvenancePatchController(runtime);

    await controller.install();

    expect(runtime.showInformation).toHaveBeenCalledWith(
      'Codex 26.826.11250 exact provenance bridge is already installed.',
    );
    expect(runtime.confirm).not.toHaveBeenCalled();
    expect(runtime.apply).not.toHaveBeenCalled();
  });

  it('does not remove unless the user confirms, then offers reload after restoration', async () => {
    const { createCodexProvenancePatchController } = await import(
      '../../src/codexProvenancePatchCommands'
    );
    let confirmed = false;
    const runtime = dependencies({
      inspect: vi.fn(async () => ({
        kind: 'patched' as const,
        extensionVersion: '26.826.11250',
      })),
      confirm: vi.fn(async (_message: string, action: string) => (
        confirmed ? action : undefined
      )),
    });
    const controller = createCodexProvenancePatchController(runtime);

    await controller.remove();
    expect(runtime.restore).not.toHaveBeenCalled();
    expect(runtime.offerReload).not.toHaveBeenCalled();

    confirmed = true;
    await controller.remove();

    expect(runtime.confirm).toHaveBeenLastCalledWith(
      expect.stringContaining('restore its verified backup'),
      'Remove Bridge',
    );
    expect(runtime.restore).toHaveBeenCalledOnce();
    expect(runtime.offerReload).toHaveBeenCalledWith(
      expect.stringContaining('removed from Codex 26.826.11250'),
      'Reload VS Code',
    );
    expect(runtime.reload).toHaveBeenCalledOnce();
  });

  it('requires confirmation to finish pending cleanup without offering a misleading reload', async () => {
    const { createCodexProvenancePatchController } = await import(
      '../../src/codexProvenancePatchCommands'
    );
    let confirmed = false;
    const runtime = dependencies({
      inspect: vi.fn(async () => ({
        kind: 'cleanup-pending' as const,
        extensionVersion: '26.826.11250',
      })),
      restore: vi.fn(async () => ({
        status: 'already-restored',
        extensionVersion: '26.826.11250',
      })),
      confirm: vi.fn(async (_message: string, action: string) => (
        confirmed ? action : undefined
      )),
    });
    const controller = createCodexProvenancePatchController(runtime);

    await controller.remove();
    expect(runtime.restore).not.toHaveBeenCalled();

    confirmed = true;
    await controller.remove();

    expect(runtime.confirm).toHaveBeenLastCalledWith(
      expect.stringContaining('clean up its verified provenance recovery artifacts'),
      'Finish Cleanup',
    );
    expect(runtime.restore).toHaveBeenCalledOnce();
    expect(runtime.showInformation).toHaveBeenCalledWith(
      'Codex 26.826.11250 provenance bridge cleanup completed; the bridge is not installed.',
    );
    expect(runtime.offerReload).not.toHaveBeenCalled();
    expect(runtime.reload).not.toHaveBeenCalled();
  });

  it('directs pending cleanup to the remove command instead of attempting install', async () => {
    const { createCodexProvenancePatchController } = await import(
      '../../src/codexProvenancePatchCommands'
    );
    const runtime = dependencies({
      inspect: vi.fn(async () => ({
        kind: 'cleanup-pending' as const,
        extensionVersion: '26.826.11250',
      })),
    });
    const controller = createCodexProvenancePatchController(runtime);

    await controller.install();

    expect(runtime.showInformation).toHaveBeenCalledWith(
      'Codex 26.826.11250 is restored, but provenance bridge cleanup is pending. '
        + 'Run the remove command to finish cleanup before installing again.',
    );
    expect(runtime.confirm).not.toHaveBeenCalled();
    expect(runtime.apply).not.toHaveBeenCalled();
  });

  it('reports missing, clean, installed, and tampered status without mutation', async () => {
    const { createCodexProvenancePatchController } = await import(
      '../../src/codexProvenancePatchCommands'
    );
    const information: string[] = [];
    const errors: string[] = [];
    let state: Record<string, unknown> = { kind: 'missing' };
    const runtime = dependencies({
      inspect: vi.fn(async () => state),
      showInformation: vi.fn(async (message: string) => { information.push(message); }),
      showError: vi.fn(async (message: string) => { errors.push(message); }),
    });
    const controller = createCodexProvenancePatchController(runtime as never);

    await controller.showStatus();
    state = { kind: 'not-patched', extensionVersion: '26.826.11250' };
    await controller.showStatus();
    state = { kind: 'patched', extensionVersion: '26.826.11250' };
    await controller.showStatus();
    state = { kind: 'cleanup-pending', extensionVersion: '26.826.11250' };
    await controller.showStatus();
    state = {
      kind: 'invalid',
      extensionVersion: '26.826.11250',
      message: 'Current Codex provenance target hash does not match patch metadata',
    };
    await controller.showStatus();

    expect(information).toEqual([
      'The OpenAI Codex extension is not installed.',
      'Codex 26.826.11250 exact provenance bridge is not installed.',
      'Codex 26.826.11250 exact provenance bridge is installed.',
      'Codex 26.826.11250 target is restored, but provenance bridge cleanup is pending. '
        + 'Run the remove command to finish cleanup.',
    ]);
    expect(errors).toEqual([
      'Codex 26.826.11250 provenance bridge state is invalid: '
        + 'Current Codex provenance target hash does not match patch metadata',
    ]);
    expect(runtime.apply).not.toHaveBeenCalled();
    expect(runtime.restore).not.toHaveBeenCalled();
  });

  it('blocks install and removal for missing, clean, or tampered states', async () => {
    const { createCodexProvenancePatchController } = await import(
      '../../src/codexProvenancePatchCommands'
    );
    const information: string[] = [];
    const errors: string[] = [];
    let state: Record<string, unknown> = { kind: 'missing' };
    const runtime = dependencies({
      inspect: vi.fn(async () => state),
      showInformation: vi.fn(async (message: string) => { information.push(message); }),
      showError: vi.fn(async (message: string) => { errors.push(message); }),
    });
    const controller = createCodexProvenancePatchController(runtime as never);

    await controller.install();
    state = { kind: 'not-patched', extensionVersion: '26.826.11250' };
    await controller.remove();
    state = { kind: 'invalid', message: 'backup hash mismatch' };
    await controller.install();
    await controller.remove();

    expect(information).toEqual([
      'The OpenAI Codex extension is not installed.',
      'Codex 26.826.11250 exact provenance bridge is not installed.',
    ]);
    expect(errors).toEqual([
      'Codex provenance bridge state is invalid: backup hash mismatch',
      'Codex provenance bridge state is invalid: backup hash mismatch',
    ]);
    expect(runtime.apply).not.toHaveBeenCalled();
    expect(runtime.restore).not.toHaveBeenCalled();
  });

  it('reports installer failures without offering reload', async () => {
    const { createCodexProvenancePatchController } = await import(
      '../../src/codexProvenancePatchCommands'
    );
    const runtime = dependencies({
      apply: vi.fn(async () => {
        throw new Error('target changed during installation');
      }),
    });
    const controller = createCodexProvenancePatchController(runtime);

    await controller.install();

    expect(runtime.showError).toHaveBeenCalledWith(
      'Could not install the Codex provenance bridge: target changed during installation',
    );
    expect(runtime.offerReload).not.toHaveBeenCalled();
    expect(runtime.reload).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      '[Codex provenance bridge] target changed during installation',
    );
  });
});
