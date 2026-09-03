import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizeUriKey } from './externalChangeDetector';

const BASELINE_SCHEME = 'codex-baseline';
const CURRENT_SCHEME = 'codex-current';

interface ReviewEntry {
  readonly resource: vscode.Uri;
  readonly baseline: vscode.Uri;
  readonly current: vscode.Uri;
  readonly generation: number;
  readonly lifecycle: 'existing' | 'created' | 'deleted';
  text: string;
}

interface SourceControlState {
  readonly sourceControl: vscode.SourceControl;
  readonly changesGroup: vscode.SourceControlResourceGroup;
}

export class QuickDiffBridge implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly entries = new Map<string, ReviewEntry>();
  private readonly contents = new Map<string, string>();
  private nextGeneration = 0;
  private readonly sourceControls = new Map<string, SourceControlState>();
  private registrations: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  update(
    key: string,
    resource: vscode.Uri,
    baselineText: string,
    lifecycle: 'existing' | 'created' | 'deleted' = 'existing',
  ): void {
    const existing = this.entries.get(key);
    const generation = existing?.generation ?? ++this.nextGeneration;
    const baseline = existing?.baseline ?? this.createBaselineUri(resource, key, generation);
    const current = lifecycle === 'deleted'
      ? existing?.current.scheme === CURRENT_SCHEME
        ? existing.current
        : this.createCurrentUri(resource, key, generation)
      : resource;
    const changed = existing?.text !== baselineText;
    if (existing !== undefined && existing.current.toString() !== current.toString()) {
      this.contents.delete(existing.current.toString());
    }
    const entry = { resource, baseline, current, generation, lifecycle, text: baselineText };
    this.entries.set(key, entry);
    this.contents.set(baseline.toString(), baselineText);
    if (lifecycle === 'deleted') {
      this.contents.set(current.toString(), '');
    }
    if (changed) {
      this.changeEmitter.fire(baseline);
    }
    this.ensureProviders();
    this.refreshProvider();
  }

  clear(key: string, acceptedText?: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return;
    }
    if (acceptedText !== undefined) {
      entry.text = acceptedText;
      this.changeEmitter.fire(entry.baseline);
    }
    this.entries.delete(key);
    this.contents.delete(entry.baseline.toString());
    this.contents.delete(entry.current.toString());

    if (this.entries.size === 0) {
      this.disposeSourceControls();
      this.disposeProviders();
    } else {
      this.refreshProvider();
    }
  }

  async openDiff(resource: vscode.Uri): Promise<boolean> {
    const entry = this.entries.get(normalizeUriKey(resource));
    if (entry === undefined) {
      return false;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      entry.baseline,
      entry.current,
      `${path.basename(resource.fsPath)} — Codex Changes`,
      { preview: true },
    );
    return true;
  }

  dispose(): void {
    this.disposeSourceControls();
    this.disposeProviders();
    this.changeEmitter.dispose();
    this.entries.clear();
    this.contents.clear();
  }

  private createBaselineUri(resource: vscode.Uri, key: string, generation: number): vscode.Uri {
    return resource.with({
      scheme: BASELINE_SCHEME,
      authority: '',
      query: `source=${encodeURIComponent(key)}&generation=${generation}`,
      fragment: '',
    });
  }

  private createCurrentUri(resource: vscode.Uri, key: string, generation: number): vscode.Uri {
    return resource.with({
      scheme: CURRENT_SCHEME,
      authority: '',
      query: `source=${encodeURIComponent(key)}&generation=${generation}`,
      fragment: '',
    });
  }

  private refreshProvider(): void {
    const entriesByRoot = new Map<string, {
      readonly rootUri: vscode.Uri | undefined;
      readonly entries: ReviewEntry[];
    }>();
    for (const entry of this.entries.values()) {
      const rootUri = vscode.workspace.getWorkspaceFolder(entry.resource)?.uri;
      const rootKey = rootUri?.toString() ?? '';
      const bucket = entriesByRoot.get(rootKey) ?? { rootUri, entries: [] };
      bucket.entries.push(entry);
      entriesByRoot.set(rootKey, bucket);
    }

    for (const [rootKey, bucket] of entriesByRoot) {
      const state = this.ensureSourceControl(rootKey, bucket.rootUri);
      state.sourceControl.quickDiffProvider = {
        provideOriginalResource: (uri) => this.entries.get(normalizeUriKey(uri))?.baseline,
      };
      state.changesGroup.resourceStates = bucket.entries
        .sort((left, right) => left.resource.fsPath.localeCompare(right.resource.fsPath))
        .map((entry) => ({
          resourceUri: entry.resource,
          contextValue: entry.lifecycle === 'deleted' ? 'codexChangeDeleted' : 'codexChange',
          command: {
            command: 'codexExtensionHelper.openDiff',
            title: 'Open Codex Changes',
            arguments: [entry.resource],
          },
        }));
      state.sourceControl.count = bucket.entries.length;
    }

    for (const [rootKey, state] of this.sourceControls) {
      if (entriesByRoot.has(rootKey)) {
        continue;
      }
      state.changesGroup.resourceStates = [];
      state.sourceControl.dispose();
      this.sourceControls.delete(rootKey);
    }
  }

  private ensureSourceControl(rootKey: string, rootUri: vscode.Uri | undefined): SourceControlState {
    const existing = this.sourceControls.get(rootKey);
    if (existing !== undefined) {
      return existing;
    }
    const sourceControl = vscode.scm.createSourceControl('codexChanges', 'Codex Changes', rootUri);
    const changesGroup = sourceControl.createResourceGroup('changes', 'Changes');
    sourceControl.inputBox.visible = false;
    const state = { sourceControl, changesGroup };
    this.sourceControls.set(rootKey, state);
    return state;
  }

  private ensureProviders(): void {
    if (this.registrations.length > 0) {
      return;
    }
    this.registrations = [
      vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, this),
      vscode.workspace.registerTextDocumentContentProvider(CURRENT_SCHEME, this),
    ];
  }

  private disposeProviders(): void {
    for (const registration of this.registrations.splice(0).reverse()) {
      registration.dispose();
    }
  }

  private disposeSourceControls(): void {
    for (const state of this.sourceControls.values()) {
      state.changesGroup.resourceStates = [];
      state.sourceControl.dispose();
    }
    this.sourceControls.clear();
  }
}
