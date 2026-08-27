import { describe, expect, it } from 'vitest';
import { applyUnifiedFilePatch, sha256Text } from '../../src/unifiedFilePatch';

describe('applyUnifiedFilePatch', () => {
  it('adds content to an empty file', () => {
    const patch = [
      '--- /dev/null',
      '+++ b/file.txt',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
      '\\ No newline at end of file',
      '',
    ].join('\n');

    expect(applyUnifiedFilePatch('', patch)).toBe('one\ntwo');
  });

  it('applies a normal replacement while retaining the final newline', () => {
    const patch = [
      '--- a/file.txt', '+++ b/file.txt',
      '@@ -1,2 +1,2 @@', ' one', '-two', '+three', '',
    ].join('\n');

    expect(applyUnifiedFilePatch('one\ntwo\n', patch)).toBe('one\nthree\n');
  });

  it('deletes all content and preserves an empty result', () => {
    const patch = [
      '--- a/file.txt', '+++ /dev/null',
      '@@ -1,2 +0,0 @@', '-one', '-two', '',
    ].join('\n');

    expect(applyUnifiedFilePatch('one\ntwo\n', patch)).toBe('');
  });

  it('applies multiple hunks in one file', () => {
    const patch = [
      '--- a/file.txt', '+++ b/file.txt',
      '@@ -1,2 +1,2 @@', ' one', '-two', '+TWO',
      '@@ -4,2 +4,2 @@', ' four', '-five', '+FIVE', '',
    ].join('\n');

    expect(applyUnifiedFilePatch('one\ntwo\nthree\nfour\nfive\n', patch))
      .toBe('one\nTWO\nthree\nfour\nFIVE\n');
  });

  it('preserves CRLF source line endings', () => {
    const patch = [
      '--- a/file.txt', '+++ b/file.txt',
      '@@ -1,2 +1,2 @@', ' one\r', '-two\r', '+three\r', '',
    ].join('\n');

    expect(applyUnifiedFilePatch('one\r\ntwo\r\n', patch)).toBe('one\r\nthree\r\n');
  });

  it('rejects an LF patch against a CRLF source', () => {
    const patch = [
      '--- a/file.txt', '+++ b/file.txt',
      '@@ -1,2 +1,2 @@', ' one', '-two', '+three', '',
    ].join('\n');

    expect(applyUnifiedFilePatch('one\r\ntwo\r\n', patch)).toBeUndefined();
  });

  it('rejects a CRLF patch against an LF source', () => {
    const patch = [
      '--- a/file.txt', '+++ b/file.txt',
      '@@ -1,2 +1,2 @@', ' one', '-two', '+three', '',
    ].join('\r\n');

    expect(applyUnifiedFilePatch('one\ntwo\n', patch)).toBeUndefined();
  });

  it('applies a final-newline addition exactly', () => {
    const patch = [
      '--- a/file.txt', '+++ b/file.txt',
      '@@ -1 +1 @@', '-one', '\\ No newline at end of file', '+one', '',
    ].join('\n');

    expect(applyUnifiedFilePatch('one', patch)).toBe('one\n');
  });

  it('applies a final-newline removal exactly', () => {
    const patch = [
      '--- a/file.txt', '+++ b/file.txt',
      '@@ -1 +1 @@', '-one', '+one', '\\ No newline at end of file', '',
    ].join('\n');

    expect(applyUnifiedFilePatch('one\n', patch)).toBe('one');
  });

  it('returns undefined for malformed headers', () => {
    const patch = ['--- a/file.txt', '+++ b/file.txt', '@@ malformed @@', ' one', ''].join('\n');

    expect(applyUnifiedFilePatch('one\n', patch)).toBeUndefined();
  });

  it('returns undefined when patch context does not match', () => {
    const patch = [
      '--- a/file.txt', '+++ b/file.txt',
      '@@ -1,2 +1,2 @@', ' expected', '-two', '+three', '',
    ].join('\n');

    expect(applyUnifiedFilePatch('unexpected\ntwo\n', patch)).toBeUndefined();
  });

  it('returns undefined for a patch rejected by diff.applyPatch', () => {
    const patch = [
      '--- a/file.txt', '+++ b/file.txt',
      '@@ -1,1 +1,1 @@', '-missing', '+replacement', '',
    ].join('\n');

    expect(applyUnifiedFilePatch('present\n', patch)).toBeUndefined();
  });
});

describe('sha256Text', () => {
  it('hashes UTF-8 text', () => {
    expect(sha256Text('안녕, 🌍')).toBe(
      'f8e9baaa6427b7681bb1b7e3c2b52a2dd63901c01111d7351ebec11ca44df747',
    );
  });
});
