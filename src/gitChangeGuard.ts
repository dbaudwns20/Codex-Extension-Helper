import * as path from 'node:path';
import * as vscode from 'vscode';

interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri?: vscode.Uri;
  readonly renameUri?: vscode.Uri;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly workingTreeChanges: readonly GitChange[];
    readonly indexChanges: readonly GitChange[];
    readonly mergeChanges: readonly GitChange[];
    readonly untrackedChanges?: readonly GitChange[];
  };
  status(): Promise<void>;
}

interface GitApi {
  readonly repositories: readonly GitRepository[];
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

export type GitResourceState = 'changed' | 'clean' | 'unavailable';

export class GitChangeGuard {
  private apiPromise: Promise<GitApi | undefined> | undefined;

  async resourceState(resource: vscode.Uri): Promise<GitResourceState> {
    try {
      const api = await (this.apiPromise ??= this.loadApi());
      const repository = api === undefined ? undefined : this.repositoryFor(api, resource);
      if (repository === undefined) {
        return 'unavailable';
      }

      await repository.status();
      const changes = [
        ...repository.state.workingTreeChanges,
        ...repository.state.indexChanges,
        ...repository.state.mergeChanges,
        ...(repository.state.untrackedChanges ?? []),
      ];
      return changes.some((change) => this.matches(change, resource)) ? 'changed' : 'clean';
    } catch {
      return 'unavailable';
    }
  }

  private async loadApi(): Promise<GitApi | undefined> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (extension === undefined) {
      return undefined;
    }
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports.getAPI(1);
  }

  private repositoryFor(api: GitApi, resource: vscode.Uri): GitRepository | undefined {
    return api.repositories
      .filter((repository) => this.isWithin(resource.fsPath, repository.rootUri.fsPath))
      .sort((left, right) => right.rootUri.fsPath.length - left.rootUri.fsPath.length)[0];
  }

  private isWithin(resourcePath: string, rootPath: string): boolean {
    const relative = path.relative(rootPath, resourcePath);
    return relative === '' || (
      relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
  }

  private matches(change: GitChange, resource: vscode.Uri): boolean {
    const key = resource.toString();
    return [change.uri, change.originalUri, change.renameUri]
      .some((candidate) => candidate?.toString() === key);
  }
}
