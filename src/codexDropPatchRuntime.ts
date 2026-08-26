import type { CodexDropPatchRuntimeDependencies, CodexDropPatchState } from './codexDropPatchCommands';

interface CodexExtension {
  readonly extensionPath: string;
  readonly packageJSON?: { readonly version?: unknown };
}

interface CodexDropPatchVsCodeApi {
  readonly extensions: {
    getExtension(id: string): CodexExtension | undefined;
  };
  readonly window: {
    showInformationMessage(message: string, options?: { modal: boolean }, ...items: string[]): PromiseLike<string | undefined>;
    showErrorMessage(message: string): PromiseLike<unknown>;
  };
  readonly commands: {
    executeCommand(command: string): PromiseLike<unknown>;
  };
}

interface CodexDropPatchInstallationResult {
  readonly status: string;
  readonly extensionVersion: string;
}

interface CodexDropPatchInstallationModule {
  inspectCodexDropPatch(options: { extensionDir: string }): Promise<CodexDropPatchInstallationResult>;
  applyCodexDropPatch(options: { extensionDir: string }): Promise<CodexDropPatchInstallationResult>;
  restoreCodexDropPatch(options: { extensionDir: string }): Promise<CodexDropPatchInstallationResult>;
}

type LoadCodexDropPatchInstallationModule = () => Promise<CodexDropPatchInstallationModule>;

async function loadCodexDropPatchInstallationModule(): Promise<CodexDropPatchInstallationModule> {
  // @ts-expect-error This JavaScript-only module is bundled into the VSIX runtime by esbuild.
  return import('../scripts/lib/codex-drop-installation.mjs');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCodexDropPatchRuntimeDependencies(
  api: CodexDropPatchVsCodeApi,
  output: { appendLine(message: string): void },
  loadModule: LoadCodexDropPatchInstallationModule = loadCodexDropPatchInstallationModule,
): CodexDropPatchRuntimeDependencies {
  const installedCodex = (): CodexExtension => {
    const extension = api.extensions.getExtension('openai.chatgpt');
    if (extension === undefined) throw new Error('The openai.chatgpt extension is not installed.');
    return extension;
  };

  return {
    inspect: async (): Promise<CodexDropPatchState> => {
      const extension = api.extensions.getExtension('openai.chatgpt');
      if (extension === undefined) return { kind: 'missing' };
      try {
        const module = await loadModule();
        const result = await module.inspectCodexDropPatch({ extensionDir: extension.extensionPath });
        if (result.status === 'patched') {
          return { kind: 'patched', extensionVersion: result.extensionVersion };
        }
        if (result.status === 'not-patched') {
          return { kind: 'not-patched', extensionVersion: result.extensionVersion };
        }
        if (result.status === 'legacy-patched') {
          return { kind: 'legacy-patched', extensionVersion: result.extensionVersion };
        }
        return {
          kind: 'invalid',
          extensionVersion: result.extensionVersion,
          message: `Unknown patch state: ${result.status}`,
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
      return module.applyCodexDropPatch({ extensionDir: extension.extensionPath });
    },
    restore: async () => {
      const extension = installedCodex();
      const module = await loadModule();
      return module.restoreCodexDropPatch({ extensionDir: extension.extensionPath });
    },
    chooseInformation: async (message, action) => api.window.showInformationMessage(
      message,
      { modal: true },
      action,
    ),
    showInformation: async (message) => api.window.showInformationMessage(message),
    showError: async (message) => api.window.showErrorMessage(message),
    reload: async () => api.commands.executeCommand('workbench.action.reloadWindow'),
    log: (message) => output.appendLine(message),
  };
}
