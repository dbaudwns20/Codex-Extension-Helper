export interface ExplorerMentionResource {
  readonly relativePath: string;
  readonly fsPath: string;
  readonly directory: boolean;
}

export interface CodexMentionAttributes {
  readonly label: string;
  readonly path: string;
  readonly fsPath: string;
}

export interface CodexMentionInsertDependencies {
  openCodexSidebar(): PromiseLike<void>;
  waitForFocus(): PromiseLike<void>;
  copyPayload(payload: string): PromiseLike<void>;
  pastePayload(): PromiseLike<void>;
}

const CODEX_MENTION_CLIPBOARD_PREFIX = 'codex-extension-helper:mentions:v1:';

export function formatExplorerResourcesAsMentions(
  resources: readonly ExplorerMentionResource[],
): CodexMentionAttributes[] {
  return resources.map((resource) => {
    const normalizedPath = resource.relativePath.replace(/\\/gu, '/');
    const mentionPath = resource.directory ? `${normalizedPath}/` : normalizedPath;
    return {
      label: normalizedPath.split('/').at(-1) ?? normalizedPath,
      path: mentionPath,
      fsPath: resource.fsPath,
    };
  });
}

export async function insertMentionsIntoCodex(
  mentions: readonly CodexMentionAttributes[],
  dependencies: CodexMentionInsertDependencies,
): Promise<void> {
  await dependencies.openCodexSidebar();
  await dependencies.waitForFocus();
  await dependencies.copyPayload(`${CODEX_MENTION_CLIPBOARD_PREFIX}${JSON.stringify(mentions)}`);
  await dependencies.pastePayload();
}
