export interface CodexDropPatchCommandController {
  install(): Promise<void>;
  remove(): Promise<void>;
  showStatus(): Promise<void>;
}

export type CodexDropPatchState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'not-patched'; readonly extensionVersion: string }
  | { readonly kind: 'patched'; readonly extensionVersion: string }
  | { readonly kind: 'legacy-patched'; readonly extensionVersion: string }
  | { readonly kind: 'invalid'; readonly extensionVersion?: string; readonly message: string };

export interface CodexDropPatchRuntimeDependencies {
  inspect(): Promise<CodexDropPatchState>;
  apply(): Promise<{ readonly status: string; readonly extensionVersion: string }>;
  restore(): Promise<{ readonly status: string; readonly extensionVersion: string }>;
  chooseInformation(message: string, action: string): Promise<string | undefined>;
  showInformation(message: string): Promise<unknown>;
  showError(message: string): Promise<unknown>;
  reload(): Promise<unknown>;
  log(message: string): void;
}

export interface CodexDropPatchController extends CodexDropPatchCommandController {
  offerInstallIfNeeded(): Promise<'not-needed' | 'dismissed' | 'patched' | 'failed'>;
}

interface Disposable {
  dispose(): unknown;
}

export function registerCodexDropPatchCommands(
  subscriptions: Disposable[],
  registerCommand: (command: string, handler: () => Promise<void>) => Disposable,
  controller: CodexDropPatchCommandController,
): void {
  subscriptions.push(registerCommand(
    'codexExtensionHelper.installCodexDropPatch',
    () => controller.install(),
  ));
  subscriptions.push(registerCommand(
    'codexExtensionHelper.removeCodexDropPatch',
    () => controller.remove(),
  ));
  subscriptions.push(registerCommand(
    'codexExtensionHelper.showCodexDropPatchStatus',
    () => controller.showStatus(),
  ));
}

export function createCodexDropPatchController(
  dependencies: CodexDropPatchRuntimeDependencies,
): CodexDropPatchController {
  const promptAndApply = async (
    state: Extract<CodexDropPatchState, { kind: 'not-patched' | 'legacy-patched' }>,
  ): Promise<'dismissed' | 'patched'> => {
    const need = state.kind === 'legacy-patched' ? 'needs a drop patch update' : 'needs the Explorer drop @mention patch';
    const action = await dependencies.chooseInformation(
      `Codex ${state.extensionVersion} ${need}.`,
      'Apply and Reload',
    );
    if (action !== 'Apply and Reload') return 'dismissed';
    const result = await dependencies.apply();
    dependencies.log(`[Codex drop patch] ${result.status} Codex ${result.extensionVersion}`);
    await dependencies.reload();
    return 'patched';
  };

  const offerInstallIfNeeded = async (): Promise<'not-needed' | 'dismissed' | 'patched' | 'failed'> => {
    try {
      const state = await dependencies.inspect();
      if (state.kind !== 'not-patched' && state.kind !== 'legacy-patched') return 'not-needed';
      return await promptAndApply(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.log(`[Codex drop patch] ${message}`);
      await dependencies.showError(`Could not apply the Codex drop patch: ${message}`);
      return 'failed';
    }
  };

  return {
    offerInstallIfNeeded,
    install: async () => {
      try {
        const state = await dependencies.inspect();
        if (state.kind === 'missing') {
          await dependencies.showInformation('The OpenAI Codex extension is not installed.');
        } else if (state.kind === 'patched') {
          await dependencies.showInformation(
            `Codex ${state.extensionVersion} Explorer drop @mention patch is already installed.`,
          );
        } else if (state.kind === 'invalid') {
          const version = state.extensionVersion === undefined ? 'Codex' : `Codex ${state.extensionVersion}`;
          await dependencies.showError(`${version} drop patch state is invalid: ${state.message}`);
        } else {
          await promptAndApply(state);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dependencies.log(`[Codex drop patch] ${message}`);
        await dependencies.showError(`Could not apply the Codex drop patch: ${message}`);
      }
    },
    remove: async () => {
      try {
        const state = await dependencies.inspect();
        if (state.kind === 'missing') {
          await dependencies.showInformation('The OpenAI Codex extension is not installed.');
          return;
        }
        if (state.kind === 'not-patched') {
          await dependencies.showInformation(
            `Codex ${state.extensionVersion} Explorer drop @mention patch is not installed.`,
          );
          return;
        }
        if (state.kind === 'invalid') {
          const version = state.extensionVersion === undefined ? 'Codex' : `Codex ${state.extensionVersion}`;
          await dependencies.showError(`${version} drop patch state is invalid: ${state.message}`);
          return;
        }
        const action = await dependencies.chooseInformation(
          `Remove the Codex ${state.extensionVersion} Explorer drop @mention patch?`,
          'Remove and Reload',
        );
        if (action !== 'Remove and Reload') return;
        const result = await dependencies.restore();
        dependencies.log(`[Codex drop patch] ${result.status} Codex ${result.extensionVersion}`);
        await dependencies.reload();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dependencies.log(`[Codex drop patch] ${message}`);
        await dependencies.showError(`Could not remove the Codex drop patch: ${message}`);
      }
    },
    showStatus: async () => {
      try {
        const state = await dependencies.inspect();
        if (state.kind === 'missing') {
          await dependencies.showInformation('The OpenAI Codex extension is not installed.');
        } else if (state.kind === 'patched') {
          await dependencies.showInformation(
            `Codex ${state.extensionVersion} Explorer drop @mention patch is installed.`,
          );
        } else if (state.kind === 'not-patched') {
          await dependencies.showInformation(
            `Codex ${state.extensionVersion} Explorer drop @mention patch is not installed.`,
          );
        } else if (state.kind === 'legacy-patched') {
          await dependencies.showInformation(
            `Codex ${state.extensionVersion} has a previous Explorer drop @mention patch that can be updated or removed.`,
          );
        } else {
          const version = state.extensionVersion === undefined ? 'Codex' : `Codex ${state.extensionVersion}`;
          await dependencies.showError(`${version} drop patch state is invalid: ${state.message}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dependencies.log(`[Codex drop patch] ${message}`);
        await dependencies.showError(`Could not inspect the Codex drop patch: ${message}`);
      }
    },
  };
}
