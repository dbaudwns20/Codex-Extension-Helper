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
  const composerContext = 'const cwd="/workspace";const isHome=cwd===`~`;';

  it('injects a marked Markdown drop handler after one composer anchor', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { PATCH_START_MARKER, patchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
    const result = patchBundleSource(`${composerContext}before;${anchor}after;`);
    expect(result.status).toBe('patched');
    expect(result.source).toContain(PATCH_START_MARKER);
  });

  it('inserts dropped Explorer resources as visible workspace-relative Markdown links', async () => {
    // Removing anchor-relative insertion, or omitting its statement terminator, breaks this fixture.
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
    const original = [
      'globalThis.__codexDropFixture=()=>{',
      'const window={addEventListener:()=>{}};',
      'const listeners={},mentions=[];let nativeHandler;',
      'let text="Review";const cwd="/workspace";const isHome=cwd===`~`;',
      'const it={getText:()=>text,setText:(value)=>{text=`parsed:${value}`},appendText:(value)=>{const addition=value.trim();text+=text&&!/\\s$/u.test(text)?` ${addition}`:addition},view:{dom:{dataset:{},addEventListener:(type,handler)=>{listeners[type]=handler}}}};',
      'let focusCount=0;const Ei=()=>{focusCount+=1};const bee=(items)=>{mentions.push(...items)};const IR=(_type,_dom,handler)=>{nativeHandler=handler};',
      anchor,
      'return {listeners,mentions,emitNative:()=>nativeHandler?.({file:{label:"native-card"}}),get text(){return text},get focusCount(){return focusCount}}};',
      '//# sourceMappingURL=app-initial.js.map',
    ].join('');
    const patched = patchBundleSource(original);
    const runFixture = new Function(`${patched.source}\nreturn globalThis.__codexDropFixture;`)();
    const fixture = runFixture();
    const event = {
      dataTransfer: {
        getData: (type: string) => type === 'text/uri-list'
          ? 'file:///workspace/scripts/lib'
          : type === 'application/vnd.code.uri-list'
            ? 'file:///workspace/scripts/lib\r\nfile:///workspace/src/Button.tsx'
          : type === 'ResourceURLs'
            ? '["file:///workspace/src/Button.tsx"]'
            : '',
        dropEffect: 'none',
      },
      preventDefault() {},
      stopImmediatePropagation() {},
    };

    fixture.listeners.drop(event);
    fixture.emitNative();

    expect(fixture.text).toBe('Review [lib](scripts/lib/) [Button.tsx](src/Button.tsx)');
    expect(fixture.mentions).toEqual([]);
    expect(fixture.focusCount).toBe(1);
    delete (globalThis as typeof globalThis & { __codexDropFixture?: unknown }).__codexDropFixture;
  });

  it('makes Explorer paths relative to the active VS Code workspace instead of the thread cwd', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
    const original = [
      'globalThis.__codexDropFixture=()=>{',
      'const window={addEventListener:()=>{}};',
      'const listeners={};let text="Review";',
      'const threadCwd="/different/thread";const isHome=threadCwd===`~`;',
      'const workspaceRoot=null;const workspace={activeWorkspaceRoot:workspaceRoot};',
      'const rootsData={roots:["/workspace"]};const workspaceRoots=rootsData?.roots??[];',
      'const it={getText:()=>text,setText:(value)=>{text=value},appendText:(value)=>{text+=` ${value.trim()}`},view:{dom:{dataset:{},addEventListener:(type,handler)=>{listeners[type]=handler}}}};',
      'const Ei=()=>{};const bee=()=>{};const IR=()=>{};',
      anchor,
      'return {listeners,get text(){return text}}};',
    ].join('');
    const patched = patchBundleSource(original);
    const runFixture = new Function(`${patched.source}\nreturn globalThis.__codexDropFixture;`)();
    const fixture = runFixture();

    fixture.listeners.drop({
      dataTransfer: {
        getData: (type: string) => type === 'application/vnd.code.uri-list'
          ? 'file:///workspace/CHANGELOG.md'
          : type === 'ResourceURLs'
            ? '["file:///workspace/CHANGELOG.md"]'
            : '',
      },
      preventDefault() {},
      stopImmediatePropagation() {},
    });

    expect(fixture.text).toBe('Review [CHANGELOG.md](CHANGELOG.md)');
    delete (globalThis as typeof globalThis & { __codexDropFixture?: unknown }).__codexDropFixture;
  });

  it('prevents the VS Code webview host from requiring Shift for Explorer drops', async () => {
    // VS Code starts its host drag mode only when dragenter was not already handled.
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
    const original = [
      'globalThis.__codexDropFixture=()=>{',
      'const listeners={},windowListeners={};',
      'const window={addEventListener:(type,handler)=>{windowListeners[type]=handler}};',
      'const cwd="/workspace";const isHome=cwd===`~`;let text="";',
      'const it={appendText:(value)=>{text=value},view:{dom:{dataset:{},addEventListener:(type,handler)=>{listeners[type]=handler}}}};',
      'const Ei=()=>{};const bee=()=>{};const IR=()=>{};',
      anchor,
      'return {listeners,windowListeners};',
      '};',
    ].join('');
    const patched = patchBundleSource(original);
    const runFixture = new Function(`${patched.source}\nreturn globalThis.__codexDropFixture;`)();
    const fixture = runFixture();
    const event = {
      defaultPrevented: false,
      dataTransfer: { types: ['application/vnd.code.uri-list'] },
      preventDefault() { this.defaultPrevented = true; },
    };

    fixture.windowListeners.dragenter?.(event);
    const hostDragStarted = !event.defaultPrevented;

    expect(hostDragStarted).toBe(false);
    delete (globalThis as typeof globalThis & { __codexDropFixture?: unknown }).__codexDropFixture;
  });

  it('allows URI-list drops while drag data is protected during dragover', async () => {
    // Reading drag payloads during dragover returns an empty string by browser design.
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
    const original = [
      'globalThis.__codexDropFixture=()=>{',
      'const window={addEventListener:()=>{}};',
      'const listeners={};',
      'let text="";const cwd="/workspace";const isHome=cwd===`~`;',
      'const it={getText:()=>text,setText:(value)=>{text=value},view:{dom:{dataset:{},addEventListener:(type,handler)=>{listeners[type]=handler}}}};',
      'const Ei=()=>{};const bee=()=>{};const IR=()=>{};',
      anchor,
      'return {listeners};',
      '};',
    ].join('');
    const patched = patchBundleSource(original);
    const runFixture = new Function(`${patched.source}\nreturn globalThis.__codexDropFixture;`)();
    const fixture = runFixture();
    let prevented = false;
    let propagationStopped = false;
    const dataTransfer = {
      types: ['text/uri-list'],
      getData: () => '',
      dropEffect: 'none',
    };

    fixture.listeners.dragover({
      dataTransfer,
      preventDefault() { prevented = true; },
      stopPropagation() { propagationStopped = true; },
    });

    expect(prevented).toBe(true);
    expect(propagationStopped).toBe(true);
    expect(dataTransfer.dropEffect).toBe('copy');
    delete (globalThis as typeof globalThis & { __codexDropFixture?: unknown }).__codexDropFixture;
  });

  it('rejects a legacy v5 injection instead of silently preserving it', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
    const legacy = `${anchor}/* codex-explorer-drop-chips:start:v5 */legacy();/* codex-explorer-drop-chips:end:v5 */`;

    expect(() => patchBundleSource(legacy)).toThrow(/unsupported Codex drop patch version v5/u);
  });

  it('is idempotent and restores the exact original source', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchBundleSource, unpatchBundleSource } = await import('../../scripts/lib/codex-drop-source.mjs');
    const original = `${composerContext}before;${anchor}after;`;
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
