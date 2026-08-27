import { PerKeyDebouncer, RecentSaveRegistry } from './changePolicy';
import { isEligibleFile, type ExtensionSettings } from './eligibility';

export interface ExternalChangeUri {
  readonly scheme: string;
  readonly path: string;
  toString(): string;
}

export type ExternalChangeCandidate =
  | {
    readonly kind: 'present';
    readonly key: string;
    readonly uri: ExternalChangeUri;
    readonly text: string;
  }
  | {
    readonly kind: 'absent';
    readonly key: string;
    readonly uri: ExternalChangeUri;
  };

export interface ExternalChangeDetectorOptions {
  readonly readFile: (uri: ExternalChangeUri) => PromiseLike<Uint8Array>;
  readonly settings: () => ExtensionSettings;
  readonly relativePath: (uri: ExternalChangeUri) => string;
  readonly onCandidate: (
    candidate: ExternalChangeCandidate,
  ) => void | PromiseLike<void>;
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
    this.schedule(uri, 'present');
  }

  handleChange(uri: ExternalChangeUri): void {
    this.schedule(uri, 'present');
  }

  handleDelete(uri: ExternalChangeUri): void {
    this.schedule(uri, 'absent');
  }

  invalidate(key: string): void {
    if (this.disposed) {
      return;
    }

    this.nextRevision(key);
    this.debouncer.cancel(key);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.debouncer.dispose();
    this.revisions.clear();
  }

  private schedule(uri: ExternalChangeUri, kind: ExternalChangeCandidate['kind']): void {
    if (this.disposed) {
      return;
    }

    const key = normalizeUriKey(uri);
    if (kind === 'present' && this.recentSaves.consume(key, this.now())) {
      this.invalidate(key);
      return;
    }

    try {
      const revision = this.nextRevision(key);
      const delayMs = this.options.settings().debounceMs;
      this.debouncer.schedule(key, delayMs, () => {
        void (kind === 'present'
          ? this.processPresent(uri, key, revision)
          : this.processAbsent(uri, key, revision));
      });
    } catch (error) {
      this.report(error);
    }
  }

  private async processPresent(
    uri: ExternalChangeUri,
    key: string,
    revision: number,
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

      await this.options.onCandidate({ kind: 'present', key, uri, text });
    } catch (error) {
      if (this.isCurrent(key, revision)) {
        this.report(error);
      }
    }
  }

  private async processAbsent(
    uri: ExternalChangeUri,
    key: string,
    revision: number,
  ): Promise<void> {
    try {
      const settings = this.options.settings();
      const relativePath = this.options.relativePath(uri);
      if (!isEligibleFile({
        scheme: uri.scheme,
        relativePath,
        text: '',
        sizeBytes: 0,
      }, settings) || !this.isCurrent(key, revision)) {
        return;
      }

      await this.options.onCandidate({ kind: 'absent', key, uri });
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
