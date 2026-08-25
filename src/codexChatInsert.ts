export interface ExplorerMentionResource {
  readonly relativePath: string;
  readonly directory: boolean;
}

export interface CodexMentionInsertDependencies {
  openCodexSidebar(): PromiseLike<void>;
  waitForFocus(): PromiseLike<void>;
  chooseMention(query: string): PromiseLike<void>;
}

export function formatExplorerResourcesAsMentionQueries(
  resources: readonly ExplorerMentionResource[],
): string[] {
  return resources.map((resource) => {
    const normalizedPath = resource.relativePath.replace(/\\/gu, '/');
    return resource.directory ? `${normalizedPath}/` : normalizedPath;
  });
}

export async function insertMentionsIntoCodex(
  queries: readonly string[],
  dependencies: CodexMentionInsertDependencies,
): Promise<void> {
  await dependencies.openCodexSidebar();
  await dependencies.waitForFocus();
  for (const query of queries) await dependencies.chooseMention(query);
}
