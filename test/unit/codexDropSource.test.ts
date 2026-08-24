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

  it('runs the drop handler in the anchor scope before a trailing source-map comment', async () => {
    // Removing anchor-relative insertion, or omitting its statement terminator, breaks this fixture.
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
    const original = [
      'globalThis.__codexDropFixture=()=>{',
      'const listeners={},mentions=[];',
      'const it={view:{dom:{dataset:{},addEventListener:(type,handler)=>{listeners[type]=handler}}}};',
      'let focusCount=0;const Ei=()=>{focusCount+=1};const bee=(items)=>{mentions.push(...items)};const IR=()=>{};',
      anchor,
      'return {listeners,mentions,get focusCount(){return focusCount}}};',
      '//# sourceMappingURL=app-initial.js.map',
    ].join('');
    const patched = patchBundleSource(original);
    const runFixture = new Function(`${patched.source}\nreturn globalThis.__codexDropFixture;`)();
    const fixture = runFixture();
    const event = {
      dataTransfer: {
        getData: (type: string) => type === 'text/uri-list' ? 'file:///workspace/src' : '',
        dropEffect: 'none',
      },
      preventDefault() {},
      stopImmediatePropagation() {},
    };

    fixture.listeners.drop(event);

    expect(fixture.mentions).toEqual([{
      label: 'src',
      path: '/workspace/src',
      fsPath: '/workspace/src',
    }]);
    expect(fixture.focusCount).toBe(1);
    delete (globalThis as typeof globalThis & { __codexDropFixture?: unknown }).__codexDropFixture;
  });

  it('rejects a legacy v1 injection instead of silently preserving it', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
    const legacy = `${anchor}/* codex-explorer-drop-chips:start:v1 */legacy();/* codex-explorer-drop-chips:end:v1 */`;

    expect(() => patchBundleSource(legacy)).toThrow(/unsupported Codex drop patch version v1/u);
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

  it.each([
    ['duplicate markers', 'duplicate'],
    ['reversed markers', 'reversed'],
    ['incomplete markers', 'incomplete'],
  ])('rejects %s rather than treating it as already patched', async (_name, kind) => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { PATCH_START_MARKER, PATCH_END_MARKER, patchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
    const source = kind === 'duplicate'
      ? `x${PATCH_START_MARKER}y${PATCH_START_MARKER}z${PATCH_END_MARKER}`
      : kind === 'reversed'
        ? `x${PATCH_END_MARKER}y${PATCH_START_MARKER}z`
        : `x${PATCH_START_MARKER}y`;
    expect(() => patchBundleSource(source)).toThrow(/well-formed/u);
  });
});
