import path from 'node:path';

export const PATCH_VERSION = 1;
export const PATCH_START_MARKER = '/* codex-explorer-drop-chips:start:v1 */';
export const PATCH_END_MARKER = '/* codex-explorer-drop-chips:end:v1 */';

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
function descriptorsFromDrop(text) {
  const descriptors = [];
  for (const raw of text.split(/\r?\n/u)) {
    const value = raw.trim();
    if (value === '' || value.startsWith('#')) continue;
    try {
      const uri = new URL(value);
      if (uri.protocol !== 'file:') continue;
      let fsPath = decodeURIComponent(uri.pathname);
      if (/^\/[A-Za-z]:\//u.test(fsPath)) fsPath = fsPath.slice(1).replaceAll('/', '\\');
      else if (uri.hostname) fsPath = `//${uri.hostname}${fsPath}`;
      const trimmed = fsPath.replace(/[\\/]+$/u, '');
      const label = trimmed.split(/[\\/]/u).at(-1) || fsPath;
      descriptors.push({ label, path: fsPath, fsPath });
    } catch {
      // Invalid or unsupported URIs are not consumed.
    }
  }
  return descriptors;
}

const COMPOSER_ANCHOR = /IR\(`add-context-file`,(?<controller>[A-Za-z_$][\w$]*)\.view\.dom,(?<event>[A-Za-z_$][\w$]*)=>\{(?<focus>[A-Za-z_$][\w$]*)\(\),(?<add>[A-Za-z_$][\w$]*)\(\[\k<event>\.file\]\)\}\);/gu;

function browserDropInjection({ controller, focus, add }) {
  const descriptorsSource = descriptorsFromDrop.toString();
  return `${PATCH_START_MARKER}(()=>{const composer=${controller}.view.dom;if(composer.dataset.codexExplorerDropChips==='1')return;composer.dataset.codexExplorerDropChips='1';const descriptorsFromDrop=${descriptorsSource};const read=(event)=>event.dataTransfer?.getData('text/uri-list')??'';composer.addEventListener('dragover',(event)=>{if(descriptorsFromDrop(read(event)).length===0)return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';},true);composer.addEventListener('drop',(event)=>{const descriptors=descriptorsFromDrop(read(event));if(descriptors.length===0)return;event.preventDefault();event.stopImmediatePropagation();${add}(descriptors);${focus}();},true);})()${PATCH_END_MARKER}`;
}

export function patchBundleSource(source) {
  if (source.includes(PATCH_START_MARKER) || source.includes(PATCH_END_MARKER)) {
    if (source.includes(PATCH_START_MARKER) && source.includes(PATCH_END_MARKER)) {
      return { status: 'already-patched', source };
    }
    throw new Error('Malformed Codex drop patch markers');
  }
  const matches = [...source.matchAll(COMPOSER_ANCHOR)];
  if (matches.length !== 1) throw new Error('Expected exactly one Codex composer anchor');
  const match = matches[0];
  const injection = browserDropInjection(match.groups);
  return { status: 'patched', source: `${source}${injection}` };
}

export function unpatchBundleSource(source) {
  const startCount = source.split(PATCH_START_MARKER).length - 1;
  const endCount = source.split(PATCH_END_MARKER).length - 1;
  if (startCount === 0 && endCount === 0) return { status: 'not-patched', source };
  if (startCount !== 1 || endCount !== 1) throw new Error('Expected exactly one Codex drop patch marker pair');
  const start = source.indexOf(PATCH_START_MARKER);
  const end = source.indexOf(PATCH_END_MARKER, start) + PATCH_END_MARKER.length;
  if (end === PATCH_END_MARKER.length - 1) throw new Error('Malformed Codex drop patch markers');
  return { status: 'restored', source: source.slice(0, start) + source.slice(end) };
}
