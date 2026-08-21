import { minimatch } from 'minimatch';

export interface ExtensionSettings {
  enabled: boolean;
  debounceMs: number;
  maxFileSizeBytes: number;
  exclude: readonly string[];
}

export interface FileEligibilityInput {
  scheme: string;
  relativePath: string;
  text: string;
  sizeBytes: number;
}

const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  debounceMs: 300,
  maxFileSizeBytes: 1024 * 1024,
  exclude: [],
};

export function normalizeSettings(settings: Partial<ExtensionSettings>): ExtensionSettings {
  const debounceMs = Number.isFinite(settings.debounceMs)
    ? Math.min(5_000, Math.max(50, settings.debounceMs!))
    : DEFAULT_SETTINGS.debounceMs;
  const maxFileSizeBytes = Number.isFinite(settings.maxFileSizeBytes)
    ? Math.max(1, Math.floor(settings.maxFileSizeBytes!))
    : DEFAULT_SETTINGS.maxFileSizeBytes;

  return {
    enabled: typeof settings.enabled === 'boolean' ? settings.enabled : DEFAULT_SETTINGS.enabled,
    debounceMs,
    maxFileSizeBytes,
    exclude: settings.exclude?.filter((pattern): pattern is string => typeof pattern === 'string')
      ?? DEFAULT_SETTINGS.exclude,
  };
}

export function isEligibleFile(
  file: FileEligibilityInput,
  settings: ExtensionSettings,
): boolean {
  if (!settings.enabled || file.scheme !== 'file') {
    return false;
  }

  if (file.sizeBytes > settings.maxFileSizeBytes || file.text.includes('\0')) {
    return false;
  }

  return !settings.exclude.some((pattern) => minimatch(file.relativePath, pattern, { dot: true }));
}
