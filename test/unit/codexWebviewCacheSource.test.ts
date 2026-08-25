import { describe, expect, it, vi } from 'vitest';

const entryTag = '<script type="module" crossorigin src="./assets/index-current.js"></script>';
const indexSource = [
  '<!doctype html><head>',
  '<!-- PROD_CSP_TAG_HERE -->',
  entryTag,
  '<link rel="modulepreload" crossorigin href="./assets/app-initial-current.js">',
  '<link rel="stylesheet" href="./assets/app.css">',
  '</head><body><div id="root"></div></body>',
].join('\n');

describe('Codex webview cache source', () => {
  it('emits bootstrap-v2 HTML and session state identifiers', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { BOOTSTRAP_ASSET_NAME, CACHE_BOOTSTRAP_VERSION, CACHE_STATE_KEY, patchIndexSource } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const patched = patchIndexSource(indexSource);

    expect(CACHE_BOOTSTRAP_VERSION).toBe(2);
    expect(BOOTSTRAP_ASSET_NAME).toBe('codex-explorer-drop-cache-bootstrap-v2.js');
    expect(CACHE_STATE_KEY).toBe('codex-explorer-drop-cache:v2');
    expect(patched.source).toContain('codex-explorer-drop-cache:start:v2');
    expect(patched.source).toContain('codex-explorer-drop-cache-bootstrap-v2.js');
  });

  it('replaces only the production entry module and restores exact HTML', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { BOOTSTRAP_ASSET_URL, patchIndexSource, unpatchIndexSource } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const patched = patchIndexSource(indexSource);
    expect(patched.status).toBe('patched');
    expect(patched.entrySource).toBe('./assets/index-current.js');
    expect(patched.source).toContain(`src="${BOOTSTRAP_ASSET_URL}"`);
    expect(patched.source).toContain('./assets/app-initial-current.js');
    expect(patched.source).toContain('./assets/app.css');
    expect(unpatchIndexSource(patched.source)).toEqual({ status: 'restored', source: indexSource });
  });

  it('is idempotent for one valid marker pair', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchIndexSource } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const first = patchIndexSource(indexSource);
    expect(patchIndexSource(first.source)).toEqual({
      status: 'already-patched',
      source: first.source,
      entrySource: './assets/index-current.js',
    });
  });

  it.each([
    ['missing entry', '<html><head></head></html>'],
    ['duplicate entry', `${entryTag}${entryTag}`],
  ])('rejects %s', async (_name, source) => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchIndexSource } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    expect(() => patchIndexSource(source)).toThrow(/exactly one Codex webview entry module/u);
  });

  it('clears current-origin caches and reloads without importing on the first load', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { CACHE_STATE_KEY, executeCacheBootstrap } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const values = new Map<string, string>();
    const deleteCache = vi.fn(async () => true);
    const reload = vi.fn();
    const importEntry = vi.fn(async () => undefined);

    await expect(executeCacheBootstrap({
      cacheStorage: { keys: async () => ['one', 'two'], delete: deleteCache },
      storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
      reload,
      importEntry,
      reportError: vi.fn(),
    })).resolves.toBe('reloaded');

    expect(deleteCache.mock.calls).toEqual([['one'], ['two']]);
    expect(values.get(CACHE_STATE_KEY)).toBe('ready');
    expect(reload).toHaveBeenCalledOnce();
    expect(importEntry).not.toHaveBeenCalled();
  });

  it('imports immediately after a successful refresh', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { executeCacheBootstrap } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const importEntry = vi.fn(async () => undefined);
    await expect(executeCacheBootstrap({
      cacheStorage: { keys: vi.fn(), delete: vi.fn() },
      storage: { getItem: () => 'ready', setItem: vi.fn() },
      reload: vi.fn(),
      importEntry,
      reportError: vi.fn(),
    })).resolves.toBe('imported');
    expect(importEntry).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing Cache Storage', undefined],
    ['cache enumeration rejection', { keys: async () => { throw new Error('cache unavailable'); }, delete: vi.fn() }],
    ['cache deletion rejection', { keys: async () => ['one'], delete: async () => { throw new Error('delete failed'); } }],
  ])('falls back to the app without a reload for %s', async (_name, cacheStorage) => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { CACHE_STATE_KEY, executeCacheBootstrap } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const values = new Map<string, string>();
    const reload = vi.fn();
    const importEntry = vi.fn(async () => undefined);
    const reportError = vi.fn();
    await expect(executeCacheBootstrap({
      cacheStorage,
      storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
      reload,
      importEntry,
      reportError,
    })).resolves.toBe('fallback');
    expect(values.get(CACHE_STATE_KEY)).toBe('failed');
    expect(reload).not.toHaveBeenCalled();
    expect(importEntry).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
  });

  it('does not retry cache deletion after a recorded failure', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { executeCacheBootstrap } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const keys = vi.fn();
    const reload = vi.fn();
    const importEntry = vi.fn(async () => undefined);
    await expect(executeCacheBootstrap({
      cacheStorage: { keys, delete: vi.fn() },
      storage: { getItem: () => 'failed', setItem: vi.fn() },
      reload,
      importEntry,
      reportError: vi.fn(),
    })).resolves.toBe('fallback');
    expect(keys).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(importEntry).toHaveBeenCalledOnce();
  });

  it('imports once without clearing caches or reloading when session state cannot be read', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { executeCacheBootstrap } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const keys = vi.fn();
    const reload = vi.fn();
    const importEntry = vi.fn(async () => undefined);
    const reportError = vi.fn();

    await expect(executeCacheBootstrap({
      cacheStorage: { keys, delete: vi.fn() },
      storage: {
        getItem: () => { throw new Error('read blocked'); },
        setItem: vi.fn(),
      },
      reload,
      importEntry,
      reportError,
    })).resolves.toBe('fallback');

    expect(keys).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(importEntry).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
  });

  it('imports once without reloading when ready state cannot be written', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { executeCacheBootstrap } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const reload = vi.fn();
    const importEntry = vi.fn(async () => undefined);
    const reportError = vi.fn();
    const deleteCache = vi.fn(async () => true);

    await expect(executeCacheBootstrap({
      cacheStorage: { keys: async () => ['one'], delete: deleteCache },
      storage: {
        getItem: () => null,
        setItem: () => { throw new Error('write blocked'); },
      },
      reload,
      importEntry,
      reportError,
    })).resolves.toBe('fallback');

    expect(deleteCache).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(importEntry).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
  });

  it('imports once when recording a failed cache operation also throws', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { executeCacheBootstrap } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const reload = vi.fn();
    const importEntry = vi.fn(async () => undefined);
    const reportError = vi.fn();

    await expect(executeCacheBootstrap({
      cacheStorage: { keys: async () => { throw new Error('cache blocked'); }, delete: vi.fn() },
      storage: {
        getItem: () => null,
        setItem: () => { throw new Error('write blocked'); },
      },
      reload,
      importEntry,
      reportError,
    })).resolves.toBe('fallback');

    expect(reload).not.toHaveBeenCalled();
    expect(importEntry).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
  });

  it('imports once when the error reporter throws', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { executeCacheBootstrap } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const values = new Map<string, string>();
    const reload = vi.fn();
    const importEntry = vi.fn(async () => undefined);

    await expect(executeCacheBootstrap({
      cacheStorage: { keys: async () => { throw new Error('cache blocked'); }, delete: vi.fn() },
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
      reload,
      importEntry,
      reportError: () => { throw new Error('report blocked'); },
    })).resolves.toBe('fallback');

    expect(reload).not.toHaveBeenCalled();
    expect(importEntry).toHaveBeenCalledOnce();
  });

  it('generates a browser bootstrap module with the captured relative entry URL', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { CACHE_STATE_KEY, createBootstrapSource } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const source = createBootstrapSource('./assets/index-current.js');
    expect(source).toContain('./assets/index-current.js');
    expect(source).toContain(CACHE_STATE_KEY);
    expect(source).toContain('document.baseURI');
    expect(source).not.toMatch(/(?:node_modules|cache-directory|\/Users\/)/u);
  });

  it('executes the generated module and imports once when the sessionStorage getter throws', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { createBootstrapSource } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const globals = globalThis as typeof globalThis & {
      __codexBootstrapImports?: number;
      caches?: unknown;
      document?: { baseURI: string };
      location?: { reload: () => void };
    };
    const globalPropertyNames = ['__codexBootstrapImports', 'caches', 'document', 'location', 'sessionStorage'] as const;
    const globalPropertyDescriptors = new Map(globalPropertyNames.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]));
    const reload = vi.fn();
    const cacheKeys = vi.fn();
    const reportError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const entrySource = `data:text/javascript,${encodeURIComponent('globalThis.__codexBootstrapImports=(globalThis.__codexBootstrapImports??0)+1;')}`;
    const generatedSource = createBootstrapSource(entrySource);
    const generatedUrl = `data:text/javascript;base64,${Buffer.from(generatedSource).toString('base64')}#${crypto.randomUUID()}`;

    globals.__codexBootstrapImports = 0;
    globals.caches = { keys: cacheKeys, delete: vi.fn() };
    globals.document = { baseURI: 'https://example.test/webview/index.html' };
    globals.location = { reload };
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get: () => { throw new Error('session storage blocked'); },
    });

    try {
      await import(generatedUrl);
      expect(globals.__codexBootstrapImports).toBe(1);
      expect(cacheKeys).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledOnce();
    } finally {
      reportError.mockRestore();
      for (const [name, descriptor] of globalPropertyDescriptors) {
        if (descriptor === undefined) delete (globalThis as unknown as Record<string, unknown>)[name];
        else Object.defineProperty(globalThis, name, descriptor);
      }
    }
  });

  it('rejects unsupported, duplicate, and reversed marker versions', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { INDEX_END_MARKER, INDEX_START_MARKER, patchIndexSource, unpatchIndexSource } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    expect(() => patchIndexSource('<!-- codex-explorer-drop-cache:start:v1 -->')).toThrow(/unsupported.*v1/u);
    const duplicate = `${INDEX_START_MARKER}${INDEX_START_MARKER}${INDEX_END_MARKER}`;
    expect(() => patchIndexSource(duplicate)).toThrow(/exactly one.*marker pair/u);
    const reversed = `${INDEX_END_MARKER}${INDEX_START_MARKER}`;
    expect(() => unpatchIndexSource(reversed)).toThrow(/exactly one.*marker pair/u);
  });

  it('rejects a marked source without an embedded original entry tag', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { INDEX_END_MARKER, INDEX_START_MARKER, unpatchIndexSource } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const malformed = `${INDEX_START_MARKER}${INDEX_END_MARKER}`;
    expect(() => unpatchIndexSource(malformed)).toThrow(/missing its original entry module/u);
  });

  it('rejects a valid marker block when an extra production entry remains outside it', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchIndexSource, unpatchIndexSource } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const patched = patchIndexSource(indexSource);
    const malformed = `${patched.source}\n${entryTag}`;
    expect(() => patchIndexSource(malformed)).toThrow(/exactly one Codex webview entry module/u);
    expect(() => unpatchIndexSource(malformed)).toThrow(/exactly one Codex webview entry module/u);
  });

  it.each([
    ['missing bootstrap script', (source: string, assetUrl: string, endMarker: string) => source.replace(`<script type="module" crossorigin src="${assetUrl}"></script>`, '')],
    ['extra marked content', (source: string, _assetUrl: string, endMarker: string) => source.replace(endMarker, `<meta name="unexpected">${endMarker}`)],
  ])('rejects marked index HTML with %s', async (_name, corrupt) => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { BOOTSTRAP_ASSET_URL, INDEX_END_MARKER, patchIndexSource, unpatchIndexSource } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const patched = patchIndexSource(indexSource);
    const malformed = corrupt(patched.source, BOOTSTRAP_ASSET_URL, INDEX_END_MARKER);

    expect(() => patchIndexSource(malformed)).toThrow(/invalid Codex webview cache patch block/u);
    expect(() => unpatchIndexSource(malformed)).toThrow(/invalid Codex webview cache patch block/u);
  });
});
