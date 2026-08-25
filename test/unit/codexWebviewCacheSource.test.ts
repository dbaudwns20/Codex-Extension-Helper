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

  it('generates a browser bootstrap module with the captured relative entry URL', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { CACHE_STATE_KEY, createBootstrapSource } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const source = createBootstrapSource('./assets/index-current.js');
    expect(source).toContain('./assets/index-current.js');
    expect(source).toContain(CACHE_STATE_KEY);
    expect(source).toContain('document.baseURI');
    expect(source).not.toMatch(/(?:node_modules|cache-directory|\/Users\/)/u);
  });

  it('rejects unsupported, duplicate, and reversed marker versions', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { patchIndexSource, unpatchIndexSource } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    expect(() => patchIndexSource('<!-- codex-explorer-drop-cache:start:v0 -->')).toThrow(/unsupported.*v0/u);
    const duplicate = '<!-- codex-explorer-drop-cache:start:v1 --><!-- codex-explorer-drop-cache:start:v1 --><!-- codex-explorer-drop-cache:end:v1 -->';
    expect(() => patchIndexSource(duplicate)).toThrow(/exactly one.*marker pair/u);
    const reversed = '<!-- codex-explorer-drop-cache:end:v1 --><!-- codex-explorer-drop-cache:start:v1 -->';
    expect(() => unpatchIndexSource(reversed)).toThrow(/exactly one.*marker pair/u);
  });

  it('rejects a marked source without an embedded original entry tag', async () => {
    // @ts-expect-error Script modules are intentionally JavaScript-only.
    const { unpatchIndexSource } = await import('../../scripts/lib/codex-webview-cache-source.mjs');
    const malformed = '<!-- codex-explorer-drop-cache:start:v1 --><!-- codex-explorer-drop-cache:end:v1 -->';
    expect(() => unpatchIndexSource(malformed)).toThrow(/missing its original entry module/u);
  });
});
