export const PROVENANCE_BRIDGE_VERSION = 1;
export const PROVENANCE_START_MARKER = '/* codex-extension-helper:provenance:start:v1 */';
export const PROVENANCE_END_MARKER = '/* codex-extension-helper:provenance:end:v1 */';

const IDENTIFIER = '[A-Za-z_$][\\w$]*';
const MARKER_PREFIX = '/* codex-extension-helper:provenance:';
const MARKER_AT_START = /^\/\* codex-extension-helper:provenance:(?<kind>start|end):v(?<version>\d+) \*\//u;

const ACTIVATION_ANCHOR = new RegExp(
  `async function (?<activation>${IDENTIFIER})\\((?<context>${IDENTIFIER})\\)\\{`
    + `let\\{subscriptions:(?<subscriptions>${IDENTIFIER})\\}=\\k<context>;`
    + `\\k<subscriptions>\\.push\\((?<logger>${IDENTIFIER})\\(\\)\\),`
    + '\\k<logger>\\(\\)\\.info\\("Activating Codex extension"\\);',
  'gu',
);

const NOTIFICATION_ANCHOR = new RegExp(
  `(?<![\\w$.])(?<subscriptions>${IDENTIFIER})\\.push\\(`
    + `(?<client>${IDENTIFIER})\\.registerInternalNotificationHandler\\(`
    + `(?<event>${IDENTIFIER})=>\\{\\k<event>\\.method==="turn/completed"&&`
    + `(?<cache>${IDENTIFIER})\\.invalidateGitReadCachesForTurn\\(`
    + `\\k<client>\\.takeCompletedTurnCwds\\(\\k<event>\\.params\\),`
    + `(?<host>${IDENTIFIER})\\.id\\)\\}\\)\\);`,
  'gu',
);

const VSCODE_USAGE_ANCHOR = new RegExp(
  `(?<![\\w$.])(?<vscode>${IDENTIFIER})\\.commands\\.executeCommand\\(`
    + `"setContext",(?<versionContext>${IDENTIFIER}),!`
    + `(?<versionCheck>${IDENTIFIER})\\(\\k<vscode>\\.version\\)\\),`
    + `\\k<vscode>\\.commands\\.executeCommand\\(`
    + `"setContext",(?<lspContext>${IDENTIFIER}),(?<lspEnabled>${IDENTIFIER})\\);`,
  'gu',
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function exactlyOne(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Codex provenance ${label} anchor`);
  }
  return matches[0];
}

function markersIn(source) {
  const markers = [];
  let index = source.indexOf(MARKER_PREFIX);
  while (index !== -1) {
    const match = source.slice(index).match(MARKER_AT_START);
    if (match === null) throw new Error('Found malformed Codex provenance bridge marker');
    const version = Number(match.groups.version);
    if (version !== PROVENANCE_BRIDGE_VERSION) {
      throw new Error(
        `Found unsupported Codex provenance bridge version v${version}; restore it before applying v${PROVENANCE_BRIDGE_VERSION}`,
      );
    }
    markers.push({
      end: index + match[0].length,
      index,
      kind: match.groups.kind,
    });
    index = source.indexOf(MARKER_PREFIX, index + MARKER_PREFIX.length);
  }
  return markers;
}

function markerPair(source) {
  const markers = markersIn(source);
  const starts = markers.filter(({ kind }) => kind === 'start');
  const ends = markers.filter(({ kind }) => kind === 'end');
  if (starts.length === 0 && ends.length === 0) return undefined;
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) {
    throw new Error('Expected exactly one well-formed Codex provenance bridge marker pair');
  }
  return { start: starts[0].index, end: ends[0].end };
}

function anchorsIn(source) {
  const activation = exactlyOne(source, ACTIVATION_ANCHOR, 'activation');
  const notification = exactlyOne(source, NOTIFICATION_ANCHOR, 'notification');
  const vscodeUsage = exactlyOne(source, VSCODE_USAGE_ANCHOR, 'VS Code usage');

  if (notification.groups.subscriptions !== activation.groups.subscriptions) {
    throw new Error('Expected exactly one Codex provenance activation subscription collection');
  }
  if (activation.index >= vscodeUsage.index || vscodeUsage.index >= notification.index) {
    throw new Error('Expected exactly one Codex provenance activation anchor sequence');
  }

  const vscode = vscodeUsage.groups.vscode;
  const vscodeImport = new RegExp(
    `var ${escapeRegExp(vscode)}=${IDENTIFIER}\\(require\\("vscode"\\)\\);`,
    'gu',
  );
  const importedVscode = exactlyOne(source, vscodeImport, 'VS Code import');
  if (importedVscode.index >= activation.index) {
    throw new Error('Expected exactly one Codex provenance VS Code import before activation');
  }

  return {
    client: notification.groups.client,
    notificationIndex: notification.index,
    subscriptions: activation.groups.subscriptions,
    vscode,
  };
}

function bridgeBlock({ client, subscriptions, vscode }) {
  return `${PROVENANCE_START_MARKER}${subscriptions}.push(${client}.registerInternalNotificationHandler(event=>{const isPatch=event?.method==="item/fileChange/patchUpdated",isCompletedFileChange=event?.method==="item/completed"&&event?.params?.item?.type==="fileChange";if(isPatch||isCompletedFileChange)void ${vscode}.commands.executeCommand("codexExtensionHelper.internal.codexProvenance",event).then(()=>void 0,()=>void 0)}));${PROVENANCE_END_MARKER}`;
}

function assertExactBridgeBlock(source, pair, anchors) {
  const expected = bridgeBlock(anchors);
  const actual = source.slice(pair.start, pair.end);
  if (actual !== expected || pair.end !== anchors.notificationIndex) {
    throw new Error('Found invalid Codex provenance bridge block');
  }
}

export function patchCodexHostSource(source) {
  const pair = markerPair(source);
  const anchors = anchorsIn(source);
  if (pair !== undefined) {
    assertExactBridgeBlock(source, pair, anchors);
    return { status: 'already-patched', source };
  }

  const block = bridgeBlock(anchors);
  return {
    status: 'patched',
    source: source.slice(0, anchors.notificationIndex)
      + block
      + source.slice(anchors.notificationIndex),
  };
}

export function unpatchCodexHostSource(source) {
  const pair = markerPair(source);
  if (pair === undefined) return { status: 'not-patched', source };
  const anchors = anchorsIn(source);
  assertExactBridgeBlock(source, pair, anchors);
  return {
    status: 'restored',
    source: source.slice(0, pair.start) + source.slice(pair.end),
  };
}
