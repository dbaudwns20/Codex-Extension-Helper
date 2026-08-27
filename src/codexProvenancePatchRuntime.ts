import type {
  CodexProvenancePatchRuntimeDependencies,
  CodexProvenancePatchState,
} from './codexProvenancePatchCommands';

interface CodexExtension {
  readonly extensionPath: string;
  readonly packageJSON?: { readonly version?: unknown };
}

interface CodexProvenancePatchVsCodeApi {
  readonly extensions: {
    getExtension(id: string): CodexExtension | undefined;
  };
  readonly window: {
    showWarningMessage(
      message: string,
      options: { modal: boolean },
      ...items: string[]
    ): PromiseLike<string | undefined>;
    showInformationMessage(message: string, ...items: string[]): PromiseLike<string | undefined>;
    showErrorMessage(message: string): PromiseLike<unknown>;
  };
  readonly commands: {
    executeCommand(command: string): PromiseLike<unknown>;
  };
}

interface CodexProvenancePatchInstallationResult {
  readonly status: string;
  readonly extensionVersion: string;
}

interface CodexProvenancePatchInstallationModule {
  inspectCodexProvenancePatch(
    options: { extensionDir: string },
  ): Promise<CodexProvenancePatchInstallationResult>;
  applyCodexProvenancePatch(
    options: { extensionDir: string },
  ): Promise<CodexProvenancePatchInstallationResult>;
  restoreCodexProvenancePatch(
    options: { extensionDir: string },
  ): Promise<CodexProvenancePatchInstallationResult>;
}

type LoadCodexProvenancePatchInstallationModule = (
) => Promise<CodexProvenancePatchInstallationModule>;

async function loadCodexProvenancePatchInstallationModule(
): Promise<CodexProvenancePatchInstallationModule> {
  // @ts-expect-error This JavaScript-only module is bundled into the VSIX runtime by esbuild.
  return import('../scripts/lib/codex-provenance-installation.mjs');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCodexProvenancePatchRuntimeDependencies(
  api: CodexProvenancePatchVsCodeApi,
  output: { appendLine(message: string): void },
  loadModule: LoadCodexProvenancePatchInstallationModule = (
    loadCodexProvenancePatchInstallationModule
  ),
): CodexProvenancePatchRuntimeDependencies {
  const installedCodex = (): CodexExtension => {
    const extension = api.extensions.getExtension('openai.chatgpt');
    if (extension === undefined) throw new Error('The openai.chatgpt extension is not installed.');
    return extension;
  };

  return {
    inspect: async (): Promise<CodexProvenancePatchState> => {
      const extension = api.extensions.getExtension('openai.chatgpt');
      if (extension === undefined) return { kind: 'missing' };
      try {
        const module = await loadModule();
        const result = await module.inspectCodexProvenancePatch({
          extensionDir: extension.extensionPath,
        });
        if (result.status === 'patched') {
          return { kind: 'patched', extensionVersion: result.extensionVersion };
        }
        if (result.status === 'not-patched') {
          return { kind: 'not-patched', extensionVersion: result.extensionVersion };
        }
        if (result.status === 'restored-pending-cleanup') {
          return { kind: 'cleanup-pending', extensionVersion: result.extensionVersion };
        }
        return {
          kind: 'invalid',
          extensionVersion: result.extensionVersion,
          message: `Unknown provenance bridge state: ${result.status}`,
        };
      } catch (error) {
        const version = extension.packageJSON?.version;
        return {
          kind: 'invalid',
          extensionVersion: typeof version === 'string' ? version : undefined,
          message: errorMessage(error),
        };
      }
    },
    apply: async () => {
      const extension = installedCodex();
      const module = await loadModule();
      return module.applyCodexProvenancePatch({ extensionDir: extension.extensionPath });
    },
    restore: async () => {
      const extension = installedCodex();
      const module = await loadModule();
      return module.restoreCodexProvenancePatch({ extensionDir: extension.extensionPath });
    },
    confirm: async (message, action) => api.window.showWarningMessage(
      message,
      { modal: true },
      action,
    ),
    offerReload: async (message, action) => api.window.showInformationMessage(message, action),
    showInformation: async (message) => api.window.showInformationMessage(message),
    showError: async (message) => api.window.showErrorMessage(message),
    reload: async () => api.commands.executeCommand('workbench.action.reloadWindow'),
    log: (message) => output.appendLine(message),
  };
}
