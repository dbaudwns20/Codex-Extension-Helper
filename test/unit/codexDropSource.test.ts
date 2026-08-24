import { describe, expect, it } from 'vitest';

describe('Codex drop source transformation', () => {
  it('creates one descriptor for each file or directory URI', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { descriptorsFromUriList } = await import('../../scripts/lib/codex-drop-source.mjs');
    expect(descriptorsFromUriList([
      'file:///Users/me/project/src/Button.tsx',
      'file:///Users/me/project/src/components',
    ].join('\r\n'), 'posix')).toEqual([
      { label: 'Button.tsx', path: '/Users/me/project/src/Button.tsx', fsPath: '/Users/me/project/src/Button.tsx' },
      { label: 'components', path: '/Users/me/project/src/components', fsPath: '/Users/me/project/src/components' },
    ]);
  });

  it('decodes spaces and Unicode while ignoring comments and non-file URIs', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { parseFileUriList } = await import('../../scripts/lib/codex-drop-source.mjs');
    expect(parseFileUriList([
      '# Explorer resources',
      'file:///Users/me/My%20Project/%ED%95%9C%EA%B8%80.ts',
      '',
      'https://example.com/not-local',
    ].join('\n'), 'posix')).toEqual(['/Users/me/My Project/한글.ts']);
  });

  it('normalizes Windows drive and UNC file URIs without expanding directories', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { parseFileUriList } = await import('../../scripts/lib/codex-drop-source.mjs');
    expect(parseFileUriList('file:///C:/repo/src', 'win32')).toEqual(['C:\\repo\\src']);
    expect(parseFileUriList('file://server/share/repo', 'win32')).toEqual(['\\\\server\\share\\repo']);
  });

  const anchor = 'IR(`add-context-file`,it.view.dom,e=>{Ei(),bee([e.file])});';

  it('injects a marked native mention drop handler after one composer anchor', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { PATCH_START_MARKER, patchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
    const result = patchBundleSource(`before;${anchor}after;`);
    expect(result.status).toBe('patched');
    expect(result.source).toContain(PATCH_START_MARKER);
    expect(result.source).toContain('bee(descriptors)');
    expect(result.source).toContain('it.view.dom');
    expect(result.source).toContain('stopImmediatePropagation');
  });

  it('is idempotent and restores the exact original source', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchBundleSource, unpatchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
    const original = `before;${anchor}after;`;
    const patched = patchBundleSource(original);
    expect(patchBundleSource(patched.source)).toEqual({ status: 'already-patched', source: patched.source });
    expect(unpatchBundleSource(patched.source)).toEqual({ status: 'restored', source: original });
  });

  it.each([
    ['missing', 'no composer here'],
    ['duplicate', `${anchor}${anchor}`],
  ])('rejects a %s composer anchor', async (_name, source) => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
    expect(() => patchBundleSource(source)).toThrow(/exactly one Codex composer anchor/u);
  });
});
