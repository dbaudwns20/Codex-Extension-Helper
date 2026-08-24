import { PerKeyDebouncer, RecentSaveRegistry } from './changePolicy';
import { isEligibleFile, type ExtensionSettings } from './eligibility';

export interface ExternalChangeUri {
  readonly scheme: string;
  readonly path: string;
  toString(): string;
}

export type ExternalChangeKind = 'create' | 'change';

export interface ExternalChangeDetectorOptions {
  readonly readFile: (uri: ExternalChangeUri) => PromiseLike<Uint8Array>;
  readonly settings: () => ExtensionSettings;
  readonly relativePath: (uri: ExternalChangeUri) => string;
  readonly onComparison: (
    key: string,
    text: string,
    kind: ExternalChangeKind,
  ) => void | PromiseLike<void>;
  readonly onDelete: (key: string) => void;
  readonly onError: (error: unknown) => void;
  readonly recentSaves?: RecentSaveRegistry;
  readonly debouncer?: PerKeyDebouncer<string>;
  readonly now?: () => number;
}

export function normalizeUriKey(uri: ExternalChangeUri): string {
  return uri.toString();
}

export class ExternalChangeDetector {
  private readonly recentSaves: RecentSaveRegistry;
  private readonly debouncer: PerKeyDebouncer<string>;
  private readonly revisions = new Map<string, number>();
  private readonly pendingCreates = new Set<string>();
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly options: ExternalChangeDetectorOptions) {
    this.recentSaves = options.recentSaves ?? new RecentSaveRegistry();
    this.debouncer = options.debouncer ?? new PerKeyDebouncer<string>();
    this.now = options.now ?? Date.now;
  }

  markRecentSave(uri: ExternalChangeUri): void {
    if (!this.disposed) {
      const key = normalizeUriKey(uri);
      this.invalidate(key);
      this.recentSaves.mark(key, this.now());
    }
  }

  handleCreate(uri: ExternalChangeUri): void {
    this.schedule(uri, 'create');
  }

  handleChange(uri: ExternalChangeUri): void {
    this.schedule(uri, 'change');
  }

  handleDelete(uri: ExternalChangeUri): void {
    if (this.disposed) {
      return;
    }

    const key = normalizeUriKey(uri);
    this.invalidate(key);

    try {
      this.options.onDelete(key);
    } catch (error) {
      this.report(error);
    }
  }

  invalidate(key: string): void {
    if (this.disposed) {
      return;
    }

    this.nextRevision(key);
    this.debouncer.cancel(key);
    this.pendingCreates.delete(key);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.debouncer.dispose();
    this.revisions.clear();
    this.pendingCreates.clear();
  }

  private schedule(uri: ExternalChangeUri, kind: ExternalChangeKind): void {
    if (this.disposed) {
      return;
    }

    const key = normalizeUriKey(uri);
    if (this.recentSaves.consume(key, this.now())) {
      this.pendingCreates.delete(key);
      return;
    }

    try {
      if (kind === 'create') {
        this.pendingCreates.add(key);
      }
      const effectiveKind: ExternalChangeKind = this.pendingCreates.has(key) ? 'create' : 'change';
      const revision = this.nextRevision(key);
      const delayMs = this.options.settings().debounceMs;
      this.debouncer.schedule(key, delayMs, () => {
        void this.process(uri, key, revision, effectiveKind);
      });
    } catch (error) {
      this.report(error);
    }
  }

  private async process(
    uri: ExternalChangeUri,
    key: string,
    revision: number,
    kind: ExternalChangeKind,
  ): Promise<void> {
    try {
      const initialSettings = this.options.settings();
      const initialRelativePath = this.options.relativePath(uri);
      if (!isEligibleFile({
        scheme: uri.scheme,
        relativePath: initialRelativePath,
        text: '',
        sizeBytes: 0,
      }, initialSettings)) {
        return;
      }

      const bytes = await this.options.readFile(uri);
      if (!this.isCurrent(key, revision)) {
        return;
      }

      const currentSettings = this.options.settings();
      const currentRelativePath = this.options.relativePath(uri);
      if (!isEligibleFile({
        scheme: uri.scheme,
        relativePath: currentRelativePath,
        text: '',
        sizeBytes: 0,
      }, currentSettings) || bytes.byteLength > currentSettings.maxFileSizeBytes) {
        return;
      }

      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return;
      }

      if (!isEligibleFile({
        scheme: uri.scheme,
        relativePath: currentRelativePath,
        text,
        sizeBytes: bytes.byteLength,
      }, currentSettings) || !this.isCurrent(key, revision)) {
        return;
      }

      await this.options.onComparison(key, text, kind);
      if (this.isCurrent(key, revision)) {
        this.pendingCreates.delete(key);
      }
    } catch (error) {
      if (this.isCurrent(key, revision)) {
        this.report(error);
      }
    }
  }

  private isCurrent(key: string, revision: number): boolean {
    return !this.disposed && this.revisions.get(key) === revision;
  }

  private nextRevision(key: string): number {
    const revision = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, revision);
    return revision;
  }

  private report(error: unknown): void {
    try {
      this.options.onError(error);
    } catch {
      // Errors from logging must not escape into VS Code's event loop.
    }
  }
}
