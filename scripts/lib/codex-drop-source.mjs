import path from 'node:path';


export const PATCH_VERSION = 6;



export const PATCH_START_MARKER = '/* codex-explorer-drop-chips:start:v6 */';
export const PATCH_END_MARKER = '/* codex-explorer-drop-chips:end:v6 */';

export function filePathFromUri(value, platform = process.platform) {
  const uri = new URL(value);
  if (uri.protocol !== 'file:') return undefined;
  let pathname = decodeURIComponent(uri.pathname);
  if (platform === 'win32') {
    if (/^\/[A-Za-z]:\//u.test(pathname)) pathname = pathname.slice(1);
    pathname = pathname.replaceAll('/', '\\');
    return uri.hostname ? `\\\\${uri.hostname}${pathname}` : pathname;
  }
  return uri.hostname ? `//${uri.hostname}${pathname}` : pathname;
}

export function parseFileUriList(text, platform = process.platform) {
  const paths = [];
  for (const line of text.split(/\r?\n/u)) {
    const value = line.trim();
    if (value === '' || value.startsWith('#')) continue;
    try {
      const filePath = filePathFromUri(value, platform);
      if (filePath !== undefined) paths.push(filePath);
    } catch {
      // Invalid or unsupported URIs are not consumed.
    }
  }
  return paths;
}

export function descriptorsFromUriList(text, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return parseFileUriList(text, platform).map((fsPath) => ({
    label: pathApi.basename(fsPath.replace(/[\\/]+$/u, '')) || fsPath,
    path: fsPath,
    fsPath,
  }));
}

// Deliberately browser-safe: this exact function is serialized into the bundle patch.
function markdownLinksFromDrop(uriListText, resourceUrlsText, rootCandidates) {
  const toPath = (value) => {
    const uri = new URL(value);
    if (uri.protocol !== 'file:') return undefined;
    let fsPath = decodeURIComponent(uri.pathname);
    if (/^\/[A-Za-z]:\//u.test(fsPath)) fsPath = fsPath.slice(1).replaceAll('/', '\\');
    else if (uri.hostname) fsPath = `//${uri.hostname}${fsPath}`;
    return fsPath;
  };
  const normalize = (value) => value.replaceAll('\\', '/').replace(/\/+$/u, '');
  const key = (value) => /^[A-Za-z]:\//u.test(value) ? value.toLowerCase() : value;
  let fileUris = [];
  try {
    const parsed = JSON.parse(resourceUrlsText);
    if (Array.isArray(parsed)) fileUris = parsed;
  } catch {
    // Missing file-only metadata means dropped entries are treated as directories.
  }
  const filePaths = new Set(fileUris.flatMap((value) => {
    try {
      const fsPath = toPath(value);
      return fsPath === undefined ? [] : [key(normalize(fsPath))];
    } catch {
      return [];
    }
  }));
  const roots = (Array.isArray(rootCandidates) ? rootCandidates : [rootCandidates]).flatMap((value) => {
    if (typeof value !== 'string' || value === '') return [];
    try {
      const rootPath = value.startsWith('file:') ? toPath(value) : value;
      return rootPath === undefined ? [] : [normalize(rootPath)];
    } catch {
      return [];
    }
  });
  const links = [];
  for (const raw of uriListText.split(/\r?\n/u)) {
    const value = raw.trim();
    if (value === '' || value.startsWith('#')) continue;
    try {
      const fsPath = toPath(value);
      if (fsPath === undefined) continue;
      const normalizedPath = normalize(fsPath);
      const pathKey = key(normalizedPath);
      let target = normalizedPath;
      const root = roots
        .filter((candidate) => pathKey.startsWith(`${key(candidate)}/`))
        .sort((left, right) => right.length - left.length)[0];
      if (root !== undefined) target = normalizedPath.slice(root.length + 1);
      const isDirectory = !filePaths.has(pathKey);
      if (isDirectory) target += '/';
      const label = normalizedPath.split('/').at(-1) || normalizedPath;
      const escapedLabel = label.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
      const encodedTarget = target.split('/').map((segment) => encodeURIComponent(segment)).join('/');
      links.push(`[${escapedLabel}](${encodedTarget})`);
    } catch {
      // Invalid or unsupported URIs are not consumed.
    }
  }
  return links;
}

const COMPOSER_ANCHOR = /IR\(`add-context-file`,(?<controller>[A-Za-z_$][\w$]*)\.view\.dom,(?<event>[A-Za-z_$][\w$]*)=>\{(?<focus>[A-Za-z_$][\w$]*)\(\),(?<add>[A-Za-z_$][\w$]*)\(\[\k<event>\.file\]\)\}\);/gu;

function browserDropInjection({ controller, focus, pathRoots }) {
  const linksSource = markdownLinksFromDrop.toString();
  return `(()=>{const composer=${controller}.view.dom;if(composer.dataset.codexExplorerDropChips==='1')return;composer.dataset.codexExplorerDropChips='1';const markdownLinksFromDrop=${linksSource};const read=(event,type)=>event.dataTransfer?.getData(type)??'';const hasUriList=(event)=>Array.from(event.dataTransfer?.types??[]).some((type)=>{const normalized=type.toLowerCase();return normalized==='text/uri-list'||normalized==='application/vnd.code.uri-list'});window.addEventListener('dragenter',(event)=>{if(hasUriList(event))event.preventDefault()},true);composer.addEventListener('dragover',(event)=>{if(!hasUriList(event))return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';},true);composer.addEventListener('drop',(event)=>{const uriList=read(event,'application/vnd.code.uri-list')||read(event,'text/uri-list');const links=markdownLinksFromDrop(uriList,read(event,'ResourceURLs'),${pathRoots});if(links.length===0)return;event.preventDefault();event.stopImmediatePropagation();${controller}.appendText(links.join(' '));${focus}();},true)})();`;
}

function composerPathRoots(source, anchorIndex) {
  const context = source.slice(Math.max(0, anchorIndex - 20_000), anchorIndex);
  const cwdMatches = [...context.matchAll(/(?<cwd>[A-Za-z_$][\w$]*)===`~`/gu)];
  const cwd = cwdMatches.at(-1)?.groups.cwd;
  if (cwd === undefined) throw new Error('Expected a Codex composer working-directory anchor');
  const workspaceMatches = [...context.matchAll(/activeWorkspaceRoot:(?<workspace>[A-Za-z_$][\w$]*)/gu)];
  const workspace = workspaceMatches.at(-1)?.groups.workspace;
  const rootsMatches = [...context.matchAll(/(?<roots>[A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\?\.roots\?\?/gu)];
  const roots = rootsMatches.at(-1)?.groups.roots;
  const fallbackRoots = workspace === undefined ? cwd : `${workspace},${cwd}`;
  return roots === undefined ? `[${fallbackRoots}]` : `[...${roots},${fallbackRoots}]`;
}

export function patchBundleSource(source) {
  const markerVersions = [...source.matchAll(/\/\* codex-explorer-drop-chips:(?:start|end):v(?<version>\d+) \*\//gu)]
    .map((match) => Number(match.groups.version));
  const unsupportedVersion = markerVersions.find((version) => version !== PATCH_VERSION);
  if (unsupportedVersion !== undefined) {
    throw new Error(`Found unsupported Codex drop patch version v${unsupportedVersion}; restore it before applying v${PATCH_VERSION}`);
  }
  const startCount = source.split(PATCH_START_MARKER).length - 1;
  const endCount = source.split(PATCH_END_MARKER).length - 1;
  if (startCount !== 0 || endCount !== 0) {
    const start = source.indexOf(PATCH_START_MARKER);
    const end = source.indexOf(PATCH_END_MARKER);
    if (startCount === 1 && endCount === 1 && start < end) {
      return { status: 'already-patched', source };
    }
    throw new Error('Expected exactly one well-formed Codex drop patch marker pair');
  }
  const matches = [...source.matchAll(COMPOSER_ANCHOR)];
  if (matches.length !== 1) throw new Error('Expected exactly one Codex composer anchor');
  const match = matches[0];
  const injection = browserDropInjection({
    ...match.groups,
    pathRoots: composerPathRoots(source, match.index),
  });
  const originalAnchor = Buffer.from(match[0], 'utf8').toString('base64');
  const patchBlock = `${PATCH_START_MARKER}${injection}/* codex-explorer-drop-chips:original:${originalAnchor} */${PATCH_END_MARKER}`;
  const endIndex = match.index + match[0].length;
  return {
    status: 'patched',
    source: source.slice(0, match.index) + patchBlock + source.slice(endIndex),
  };
}

export function unpatchBundleSource(source) {
  const startCount = source.split(PATCH_START_MARKER).length - 1;
  const endCount = source.split(PATCH_END_MARKER).length - 1;
  if (startCount === 0 && endCount === 0) return { status: 'not-patched', source };
  if (startCount !== 1 || endCount !== 1) throw new Error('Expected exactly one Codex drop patch marker pair');
  const start = source.indexOf(PATCH_START_MARKER);
  const end = source.indexOf(PATCH_END_MARKER, start) + PATCH_END_MARKER.length;
  if (end === PATCH_END_MARKER.length - 1) throw new Error('Malformed Codex drop patch markers');
  const patchBlock = source.slice(start, end);
  const originalMatch = patchBlock.match(/\/\* codex-explorer-drop-chips:original:(?<anchor>[A-Za-z0-9+/=]+) \*\//u);
  if (originalMatch === null) throw new Error('Codex drop patch is missing its original composer anchor');
  const originalAnchor = Buffer.from(originalMatch.groups.anchor, 'base64').toString('utf8');
  return { status: 'restored', source: source.slice(0, start) + originalAnchor + source.slice(end) };
}
