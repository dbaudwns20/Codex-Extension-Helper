import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizeUriKey } from './externalChangeDetector';

const BASELINE_SCHEME = 'codex-baseline';

interface BaselineEntry {
  readonly resource: vscode.Uri;
  readonly baseline: vscode.Uri;
  text: string;
}

export class QuickDiffBridge implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly entries = new Map<string, BaselineEntry>();
  private readonly contents = new Map<string, string>();
  private readonly sourceControl: vscode.SourceControl;
  private readonly registration: vscode.Disposable;
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  constructor() {
    this.sourceControl = vscode.scm.createSourceControl('codexChanges', 'Codex Changes');
    this.sourceControl.inputBox.visible = false;
    this.sourceControl.count = 0;
    this.registration = vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, this);
    this.refreshProvider();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  show(key: string, resource: vscode.Uri, baselineText: string): void {
    const existing = this.entries.get(key);
    const baseline = existing?.baseline ?? this.createBaselineUri(resource, key);
    const changed = existing?.text !== baselineText;
    const entry = { resource, baseline, text: baselineText };
    this.entries.set(key, entry);
    this.contents.set(baseline.toString(), baselineText);
    if (changed) {
      this.changeEmitter.fire(baseline);
    }
    this.refreshProvider();
  }

  clear(key: string, acceptedText?: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return;
    }
    if (acceptedText !== undefined) {
      entry.text = acceptedText;
      this.contents.set(entry.baseline.toString(), acceptedText);
      this.changeEmitter.fire(entry.baseline);
    }
    this.entries.delete(key);
    this.refreshProvider();
  }

  async openDiff(resource: vscode.Uri): Promise<boolean> {
    const entry = this.entries.get(normalizeUriKey(resource));
    if (entry === undefined) {
      return false;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      entry.baseline,
      entry.resource,
      `${path.basename(resource.fsPath)} — Codex Changes`,
      { preview: true },
    );
    return true;
  }

  dispose(): void {
    this.registration.dispose();
    this.sourceControl.dispose();
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

  private refreshProvider(): void {
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: (uri) => this.entries.get(normalizeUriKey(uri))?.baseline,
    };
  }
}
