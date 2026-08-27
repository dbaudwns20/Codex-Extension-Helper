import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizeUriKey } from './externalChangeDetector';

const BASELINE_SCHEME = 'codex-baseline';
const CURRENT_SCHEME = 'codex-current';

interface ReviewEntry {
  readonly resource: vscode.Uri;
  readonly baseline: vscode.Uri;
  readonly current: vscode.Uri;
  text: string;
}

export class QuickDiffBridge implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly entries = new Map<string, ReviewEntry>();
  private readonly contents = new Map<string, string>();
  private sourceControl: vscode.SourceControl | undefined;
  private changesGroup: vscode.SourceControlResourceGroup | undefined;
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
    const baseline = existing?.baseline ?? this.createBaselineUri(resource, key);
    const current = lifecycle === 'deleted'
      ? existing?.current.scheme === CURRENT_SCHEME
        ? existing.current
        : this.createCurrentUri(resource, key)
      : resource;
    const changed = existing?.text !== baselineText;
    if (existing !== undefined && existing.current.toString() !== current.toString()) {
      this.contents.delete(existing.current.toString());
    }
    const entry = { resource, baseline, current, text: baselineText };
    this.entries.set(key, entry);
    this.contents.set(baseline.toString(), baselineText);
    if (lifecycle === 'deleted') {
      this.contents.set(current.toString(), '');
    }
    if (changed) {
      this.changeEmitter.fire(baseline);
    }
    this.ensureSourceControl();
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
      this.disposeSourceControl();
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
    this.disposeSourceControl();
    this.disposeProviders();
    this.changeEmitter.dispose();
    this.entries.clear();
    this.contents.clear();
  }

  private createBaselineUri(resource: vscode.Uri, key: string): vscode.Uri {
    return resource.with({
      scheme: BASELINE_SCHEME,
      authority: '',
      query: `source=${encodeURIComponent(key)}`,
      fragment: '',
    });
  }

  private createCurrentUri(resource: vscode.Uri, key: string): vscode.Uri {
    return resource.with({
      scheme: CURRENT_SCHEME,
      authority: '',
      query: `source=${encodeURIComponent(key)}`,
      fragment: '',
    });
  }

  private refreshProvider(): void {
    if (this.sourceControl === undefined) {
      return;
    }
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: (uri) => this.entries.get(normalizeUriKey(uri))?.baseline,
    };
    if (this.changesGroup !== undefined) {
      this.changesGroup.resourceStates = [...this.entries.values()]
        .sort((left, right) => left.resource.fsPath.localeCompare(right.resource.fsPath))
        .map((entry) => ({
          resourceUri: entry.resource,
          contextValue: 'codexChange',
          command: {
            command: 'codexExtensionHelper.openDiff',
            title: 'Open Codex Changes',
            arguments: [entry.resource],
          },
        }));
    }
    this.sourceControl.count = this.entries.size;
  }

  private ensureSourceControl(): void {
    this.ensureProviders();
    if (this.sourceControl !== undefined) {
      return;
    }
    this.sourceControl = vscode.scm.createSourceControl('codexChanges', 'Codex Changes');
    this.changesGroup = this.sourceControl.createResourceGroup('changes', 'Changes');
    this.sourceControl.inputBox.visible = false;
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

  private disposeSourceControl(): void {
    if (this.changesGroup !== undefined) {
      this.changesGroup.resourceStates = [];
    }
    this.sourceControl?.dispose();
    this.sourceControl = undefined;
    this.changesGroup = undefined;
  }
}
