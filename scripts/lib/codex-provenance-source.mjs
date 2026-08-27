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

const CONTROL_PAREN_KEYWORDS = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);
const EXPRESSION_PREFIX_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

function skipQuotedString(source, start, quote) {
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      if (index + 1 >= source.length) throw new Error('unterminated string escape');
      index += 2;
      continue;
    }
    if (character === quote) return index + 1;
    if (character === '\n' || character === '\r') throw new Error('unterminated string literal');
    index += 1;
  }
  throw new Error('unterminated string literal');
}

function skipBlockComment(source, start) {
  const end = source.indexOf('*/', start + 2);
  if (end === -1) throw new Error('unterminated block comment');
  return end + 2;
}

function skipLineComment(source, start) {
  const lineFeed = source.indexOf('\n', start + 2);
  const carriageReturn = source.indexOf('\r', start + 2);
  if (lineFeed === -1) return carriageReturn === -1 ? source.length : carriageReturn;
  if (carriageReturn === -1) return lineFeed;
  return Math.min(lineFeed, carriageReturn);
}

function skipRegexLiteral(source, start) {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      if (index + 1 >= source.length) throw new Error('unterminated regular expression escape');
      index += 2;
      continue;
    }
    if (character === '\n' || character === '\r') {
      throw new Error('unterminated regular expression literal');
    }
    if (character === '[') inCharacterClass = true;
    else if (character === ']') inCharacterClass = false;
    else if (character === '/' && inCharacterClass === false) {
      index += 1;
      while (/[A-Za-z]/u.test(source[index] ?? '')) index += 1;
      return index;
    }
    index += 1;
  }
  throw new Error('unterminated regular expression literal');
}

function skipTemplateLiteral(source, start) {
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      if (index + 1 >= source.length) throw new Error('unterminated template escape');
      index += 2;
      continue;
    }
    if (character === '`') return index + 1;
    if (character === '$' && source[index + 1] === '{') {
      index = matchingBraceIndex(source, index + 1) + 1;
      continue;
    }
    index += 1;
  }
  throw new Error('unterminated template literal');
}

function matchingBraceIndex(source, openingBrace) {
  if (source[openingBrace] !== '{') throw new Error('expected an opening brace');
  let braceDepth = 1;
  let bracketDepth = 0;
  let index = openingBrace + 1;
  let pendingControlParen = false;
  const controlParens = [];
  let regexState = 'allowed';

  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index);
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index);
      continue;
    }
    if (character === '"' || character === "'") {
      pendingControlParen = false;
      index = skipQuotedString(source, index, character);
      regexState = 'disallowed';
      continue;
    }
    if (character === '`') {
      pendingControlParen = false;
      index = skipTemplateLiteral(source, index);
      regexState = 'disallowed';
      continue;
    }
    if (character === '/') {
      pendingControlParen = false;
      if (regexState === 'ambiguous') {
        throw new Error('ambiguous slash after a closing brace');
      }
      if (regexState === 'allowed') {
        index = skipRegexLiteral(source, index);
        regexState = 'disallowed';
      } else {
        index += source[index + 1] === '=' ? 2 : 1;
        regexState = 'allowed';
      }
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      let end = index + 1;
      while (/[\w$]/u.test(source[end] ?? '')) end += 1;
      const word = source.slice(index, end);
      pendingControlParen = CONTROL_PAREN_KEYWORDS.has(word);
      regexState = pendingControlParen || EXPRESSION_PREFIX_KEYWORDS.has(word)
        ? 'allowed'
        : 'disallowed';
      index = end;
      continue;
    }
    if (/[0-9]/u.test(character)) {
      pendingControlParen = false;
      let end = index + 1;
      while (/[\w.]/u.test(source[end] ?? '')) end += 1;
      index = end;
      regexState = 'disallowed';
      continue;
    }

    if (character !== '(') pendingControlParen = false;
    if (character === '(') {
      controlParens.push(pendingControlParen);
      pendingControlParen = false;
      regexState = 'allowed';
    } else if (character === ')') {
      if (controlParens.length === 0) throw new Error('unmatched closing parenthesis');
      regexState = controlParens.pop() ? 'allowed' : 'disallowed';
    } else if (character === '[') {
      bracketDepth += 1;
      regexState = 'allowed';
    } else if (character === ']') {
      if (bracketDepth === 0) throw new Error('unmatched closing bracket');
      bracketDepth -= 1;
      regexState = 'disallowed';
    } else if (character === '{') {
      braceDepth += 1;
      regexState = 'allowed';
    } else if (character === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) {
        if (controlParens.length !== 0 || bracketDepth !== 0) {
          throw new Error('unbalanced delimiter before the closing brace');
        }
        return index;
      }
      regexState = 'ambiguous';
    } else if (character === '.' && source.slice(index, index + 3) === '...') {
      index += 2;
      regexState = 'allowed';
    } else if (character === '.') {
      regexState = 'disallowed';
    } else if ((character === '+' || character === '-') && source[index + 1] === character) {
      index += 1;
      regexState = regexState === 'disallowed' ? 'disallowed' : 'allowed';
    } else {
      regexState = 'allowed';
    }
    index += 1;
  }
  throw new Error('unterminated code block');
}

function activationBodyClosingBrace(source, activation) {
  const relativeOpeningBrace = activation[0].indexOf('{');
  if (relativeOpeningBrace === -1) {
    throw new Error('Could not establish the Codex activation function boundary: missing opening brace');
  }
  try {
    return matchingBraceIndex(source, activation.index + relativeOpeningBrace);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not establish the Codex activation function boundary: ${detail}`);
  }
}

function anchorsIn(source, pair) {
  const activation = exactlyOne(source, ACTIVATION_ANCHOR, 'activation');
  const notification = exactlyOne(source, NOTIFICATION_ANCHOR, 'notification');
  const vscodeUsage = exactlyOne(source, VSCODE_USAGE_ANCHOR, 'VS Code usage');

  if (notification.groups.subscriptions !== activation.groups.subscriptions) {
    throw new Error('Expected exactly one Codex provenance activation subscription collection');
  }
  if (activation.index >= vscodeUsage.index || vscodeUsage.index >= notification.index) {
    throw new Error('Expected exactly one Codex provenance activation anchor sequence');
  }

  const activationClose = activationBodyClosingBrace(source, activation);
  const insertionIndex = pair?.start ?? notification.index;
  if (
    vscodeUsage.index >= activationClose
    || notification.index >= activationClose
    || insertionIndex >= activationClose
  ) {
    throw new Error('Expected the Codex provenance anchors and insertion point inside the Codex activation function body');
  }
  if (source[insertionIndex - 1] !== ';') {
    throw new Error('Expected a standalone statement boundary before the Codex provenance insertion point');
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
  const anchors = anchorsIn(source, pair);
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
  const anchors = anchorsIn(source, pair);
  assertExactBridgeBlock(source, pair, anchors);
  return {
    status: 'restored',
    source: source.slice(0, pair.start) + source.slice(pair.end),
  };
}
