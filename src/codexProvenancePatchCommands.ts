export interface CodexProvenancePatchCommandController {
  install(): Promise<void>;
  remove(): Promise<void>;
  showStatus(): Promise<void>;
}

export type CodexProvenancePatchState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'not-patched'; readonly extensionVersion: string }
  | { readonly kind: 'patched'; readonly extensionVersion: string }
  | { readonly kind: 'invalid'; readonly extensionVersion?: string; readonly message: string };

export interface CodexProvenancePatchRuntimeDependencies {
  inspect(): Promise<CodexProvenancePatchState>;
  apply(): Promise<{ readonly status: string; readonly extensionVersion: string }>;
  restore(): Promise<{ readonly status: string; readonly extensionVersion: string }>;
  confirm(message: string, action: string): Promise<string | undefined>;
  offerReload(message: string, action: string): Promise<string | undefined>;
  showInformation(message: string): Promise<unknown>;
  showError(message: string): Promise<unknown>;
  reload(): Promise<unknown>;
  log(message: string): void;
}

interface Disposable {
  dispose(): unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function versionLabel(state: Extract<CodexProvenancePatchState, { kind: 'invalid' }>): string {
  return state.extensionVersion === undefined ? 'Codex' : `Codex ${state.extensionVersion}`;
}

export function registerCodexProvenancePatchCommands(
  subscriptions: Disposable[],
  registerCommand: (command: string, handler: () => Promise<void>) => Disposable,
  controller: CodexProvenancePatchCommandController,
): void {
  subscriptions.push(registerCommand(
    'codexExtensionHelper.installProvenanceBridge',
    () => controller.install(),
  ));
  subscriptions.push(registerCommand(
    'codexExtensionHelper.removeProvenanceBridge',
    () => controller.remove(),
  ));
  subscriptions.push(registerCommand(
    'codexExtensionHelper.showProvenanceBridgeStatus',
    () => controller.showStatus(),
  ));
}

export function createCodexProvenancePatchController(
  dependencies: CodexProvenancePatchRuntimeDependencies,
): CodexProvenancePatchCommandController {
  const offerReload = async (message: string): Promise<void> => {
    const action = await dependencies.offerReload(message, 'Reload VS Code');
    if (action === 'Reload VS Code') await dependencies.reload();
  };

  const showInvalidState = async (
    state: Extract<CodexProvenancePatchState, { kind: 'invalid' }>,
  ): Promise<void> => {
    await dependencies.showError(
      `${versionLabel(state)} provenance bridge state is invalid: ${state.message}`,
    );
  };

  return {
    install: async () => {
      try {
        const state = await dependencies.inspect();
        if (state.kind === 'missing') {
          await dependencies.showInformation('The OpenAI Codex extension is not installed.');
          return;
        }
        if (state.kind === 'patched') {
          await dependencies.showInformation(
            `Codex ${state.extensionVersion} exact provenance bridge is already installed.`,
          );
          return;
        }
        if (state.kind === 'invalid') {
          await showInvalidState(state);
          return;
        }

        const action = await dependencies.confirm(
          `Install the exact provenance bridge for Codex ${state.extensionVersion}? `
            + 'This will modify the installed Codex extension and preserve a verified backup.',
          'Install Bridge',
        );
        if (action !== 'Install Bridge') return;

        const result = await dependencies.apply();
        dependencies.log(
          `[Codex provenance bridge] ${result.status} Codex ${result.extensionVersion}`,
        );
        if (result.status === 'patched') {
          await offerReload(
            `The exact provenance bridge was installed for Codex ${result.extensionVersion}.`,
          );
        } else if (result.status === 'already-patched') {
          await dependencies.showInformation(
            `Codex ${result.extensionVersion} exact provenance bridge is already installed.`,
          );
        } else {
          throw new Error(`Unexpected install status: ${result.status}`);
        }
      } catch (error) {
        const message = errorMessage(error);
        dependencies.log(`[Codex provenance bridge] ${message}`);
        await dependencies.showError(`Could not install the Codex provenance bridge: ${message}`);
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
            `Codex ${state.extensionVersion} exact provenance bridge is not installed.`,
          );
          return;
        }
        if (state.kind === 'invalid') {
          await showInvalidState(state);
          return;
        }

        const action = await dependencies.confirm(
          `Remove the exact provenance bridge from Codex ${state.extensionVersion} `
            + 'and restore its verified backup?',
          'Remove Bridge',
        );
        if (action !== 'Remove Bridge') return;

        const result = await dependencies.restore();
        dependencies.log(
          `[Codex provenance bridge] ${result.status} Codex ${result.extensionVersion}`,
        );
        if (result.status === 'restored') {
          await offerReload(
            `The exact provenance bridge was removed from Codex ${result.extensionVersion}.`,
          );
        } else if (result.status === 'already-restored') {
          await dependencies.showInformation(
            `Codex ${result.extensionVersion} exact provenance bridge is not installed.`,
          );
        } else {
          throw new Error(`Unexpected removal status: ${result.status}`);
        }
      } catch (error) {
        const message = errorMessage(error);
        dependencies.log(`[Codex provenance bridge] ${message}`);
        await dependencies.showError(`Could not remove the Codex provenance bridge: ${message}`);
      }
    },

    showStatus: async () => {
      try {
        const state = await dependencies.inspect();
        if (state.kind === 'missing') {
          await dependencies.showInformation('The OpenAI Codex extension is not installed.');
        } else if (state.kind === 'not-patched') {
          await dependencies.showInformation(
            `Codex ${state.extensionVersion} exact provenance bridge is not installed.`,
          );
        } else if (state.kind === 'patched') {
          await dependencies.showInformation(
            `Codex ${state.extensionVersion} exact provenance bridge is installed.`,
          );
        } else {
          await showInvalidState(state);
        }
      } catch (error) {
        const message = errorMessage(error);
        dependencies.log(`[Codex provenance bridge] ${message}`);
        await dependencies.showError(`Could not inspect the Codex provenance bridge: ${message}`);
      }
    },
  };
}
