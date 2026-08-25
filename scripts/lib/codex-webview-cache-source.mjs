export const CACHE_BOOTSTRAP_VERSION = 1;
export const BOOTSTRAP_ASSET_NAME = `codex-explorer-drop-cache-bootstrap-v${CACHE_BOOTSTRAP_VERSION}.js`;
export const BOOTSTRAP_ASSET_URL = `./assets/${BOOTSTRAP_ASSET_NAME}`;
export const INDEX_START_MARKER = `<!-- codex-explorer-drop-cache:start:v${CACHE_BOOTSTRAP_VERSION} -->`;
export const INDEX_END_MARKER = `<!-- codex-explorer-drop-cache:end:v${CACHE_BOOTSTRAP_VERSION} -->`;
export const CACHE_STATE_KEY = `codex-explorer-drop-cache:v${CACHE_BOOTSTRAP_VERSION}`;

const ENTRY_MODULE = /<script\s+type="module"\s+crossorigin\s+src="(?<source>\.\/assets\/index-[^"]+\.js)"><\/script>/gu;
const ENTRY_MODULE_EXACT = /^<script\s+type="module"\s+crossorigin\s+src="(?<source>\.\/assets\/index-[^"]+\.js)"><\/script>$/u;
const MARKER = /<!-- codex-explorer-drop-cache:(?<kind>start|end):v(?<version>\d+) -->/gu;

function markersIn(source) {
  return [...source.matchAll(MARKER)].map((match) => ({
    index: match.index,
    kind: match.groups.kind,
    version: Number(match.groups.version),
  }));
}

function assertSupportedMarkers(source) {
  const unsupported = markersIn(source).find(({ version }) => version !== CACHE_BOOTSTRAP_VERSION);
  if (unsupported !== undefined) {
    throw new Error(`Found unsupported Codex webview cache patch version v${unsupported.version}; restore it before applying v${CACHE_BOOTSTRAP_VERSION}`);
  }
}

function markerPair(source) {
  const markers = markersIn(source);
  const starts = markers.filter(({ kind }) => kind === 'start');
  const ends = markers.filter(({ kind }) => kind === 'end');
  if (starts.length === 0 && ends.length === 0) return undefined;
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) {
    throw new Error('Expected exactly one well-formed Codex webview cache marker pair');
  }
  return { start: starts[0].index, end: ends[0].index + INDEX_END_MARKER.length };
}

function originalTagFromBlock(block) {
  const originalMatch = block.match(/<!-- codex-explorer-drop-cache:original:(?<tag>[A-Za-z0-9+/=]+) -->/u);
  if (originalMatch === null) throw new Error('Codex webview cache patch is missing its original entry module');
  const originalTag = Buffer.from(originalMatch.groups.tag, 'base64').toString('utf8');
  if (ENTRY_MODULE_EXACT.test(originalTag) === false) {
    throw new Error('Codex webview cache patch contains an invalid original entry module');
  }
  return originalTag;
}

export function patchIndexSource(source) {
  assertSupportedMarkers(source);
  const pair = markerPair(source);
  if (pair !== undefined) {
    const block = source.slice(pair.start, pair.end);
    const originalTag = originalTagFromBlock(block);
    const match = originalTag.match(ENTRY_MODULE_EXACT);
    return { status: 'already-patched', source, entrySource: match.groups.source };
  }

  const matches = [...source.matchAll(ENTRY_MODULE)];
  if (matches.length !== 1) throw new Error('Expected exactly one Codex webview entry module');
  const match = matches[0];
  const encodedTag = Buffer.from(match[0], 'utf8').toString('base64');
  const replacement = `${INDEX_START_MARKER}<script type="module" crossorigin src="${BOOTSTRAP_ASSET_URL}"></script><!-- codex-explorer-drop-cache:original:${encodedTag} -->${INDEX_END_MARKER}`;
  return {
    status: 'patched',
    source: source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length),
    entrySource: match.groups.source,
  };
}

export function unpatchIndexSource(source) {
  assertSupportedMarkers(source);
  const pair = markerPair(source);
  if (pair === undefined) return { status: 'not-patched', source };
  const block = source.slice(pair.start, pair.end);
  const originalTag = originalTagFromBlock(block);
  return { status: 'restored', source: source.slice(0, pair.start) + originalTag + source.slice(pair.end) };
}

export async function executeCacheBootstrap({ cacheStorage, storage, reload, importEntry, reportError }) {
  const state = storage.getItem(CACHE_STATE_KEY);
  if (state === 'ready') {
    await importEntry();
    return 'imported';
  }
  if (state === 'failed') {
    await importEntry();
    return 'fallback';
  }
  try {
    if (cacheStorage === undefined) throw new Error('Cache Storage API is unavailable');
    const names = await cacheStorage.keys();
    await Promise.all(names.map((name) => cacheStorage.delete(name)));
    storage.setItem(CACHE_STATE_KEY, 'ready');
    reload();
    return 'reloaded';
  } catch (error) {
    storage.setItem(CACHE_STATE_KEY, 'failed');
    reportError(error);
    await importEntry();
    return 'fallback';
  }
}

export function createBootstrapSource(entrySource) {
  const entryLiteral = JSON.stringify(entrySource);
  const behaviorSource = executeCacheBootstrap.toString();
  return `const CACHE_STATE_KEY=${JSON.stringify(CACHE_STATE_KEY)};const executeCacheBootstrap=${behaviorSource};const entryUrl=new URL(${entryLiteral},document.baseURI).href;await executeCacheBootstrap({cacheStorage:globalThis.caches,storage:globalThis.sessionStorage,reload:()=>globalThis.location.reload(),importEntry:()=>import(entryUrl),reportError:(error)=>console.error('Codex drop cache refresh failed',error)});\n`;
}
