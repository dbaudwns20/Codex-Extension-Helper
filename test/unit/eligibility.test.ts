import { describe, expect, it } from 'vitest';
import { isEligibleFile, normalizeSettings } from '../../src/eligibility';

describe('eligibility policy', () => {
  const settings = normalizeSettings({
    enabled: true,
    debounceMs: 300,
    maxFileSizeBytes: 16,
    exclude: ['**/node_modules/**', '**/.git/**'],
  });

  it('rejects documents that do not use the file scheme', () => {
    expect(isEligibleFile({
      scheme: 'untitled',
      relativePath: 'notes.txt',
      text: 'notes',
      sizeBytes: 5,
    }, settings)).toBe(false);
  });

  it('rejects paths matching an exclusion pattern including dot directories', () => {
    expect(isEligibleFile({
      scheme: 'file',
      relativePath: '.git/config',
      text: 'config',
      sizeBytes: 6,
    }, settings)).toBe(false);
  });

  it('rejects decoded text containing a NUL byte', () => {
    expect(isEligibleFile({
      scheme: 'file',
      relativePath: 'image.dat',
      text: 'text\0binary',
      sizeBytes: 11,
    }, settings)).toBe(false);
  });

  it('rejects files larger than the configured byte limit', () => {
    expect(isEligibleFile({
      scheme: 'file',
      relativePath: 'large.txt',
      text: '0123456789abcdef!',
      sizeBytes: 17,
    }, settings)).toBe(false);
  });

  it('accepts a regular text file at the configured size limit', () => {
    expect(isEligibleFile({
      scheme: 'file',
      relativePath: 'src/example.ts',
      text: '0123456789abcdef',
      sizeBytes: 16,
    }, settings)).toBe(true);
  });

  it('clamps debounce and normalizes the size limit to a positive integer', () => {
    expect(normalizeSettings({
      enabled: true,
      debounceMs: 10_000,
      maxFileSizeBytes: 0.8,
      exclude: [],
    })).toMatchObject({ debounceMs: 5_000, maxFileSizeBytes: 1 });

    expect(normalizeSettings({
      enabled: true,
      debounceMs: 1,
      maxFileSizeBytes: 1.9,
      exclude: [],
    })).toMatchObject({ debounceMs: 50, maxFileSizeBytes: 1 });
  });
});
