import { describe, expect, it } from 'vitest';

const VSCODE_IMPORT = 'var ht=U(require("vscode"));';
const ACTIVATION_HEADER = 'async function twt(t){let{subscriptions:e}=t;e.push(K()),K().info("Activating Codex extension");';
const VSCODE_USAGE = 'ht.commands.executeCommand("setContext",Vxe,!mP(ht.version)),ht.commands.executeCommand("setContext",QSt,i);';
const NOTIFICATION_ANCHOR = 'e.push(p.registerInternalNotificationHandler(xe=>{xe.method==="turn/completed"&&_.invalidateGitReadCachesForTurn(p.takeCompletedTurnCwds(xe.params),A.id)}));';

function minifiedHostFixture() {
  return [
    'var Kz=U(require("vscode"));var Lh=U(require("vscode"));',
    VSCODE_IMPORT,
    'const K=()=>({info:()=>{}}),Vxe="host.version",QSt="host.lsp",mP=()=>!1;',
    'function qL(s){return s.registerInternalNotificationHandler(G=>{G.method==="item/completed"&&void 0})}',
    ACTIVATION_HEADER,
    'let i=!1,p=t.appServerClient,_={invalidateGitReadCachesForTurn:()=>{}},A={id:"host"};',
    VSCODE_USAGE,
    NOTIFICATION_ANCHOR,
    '}globalThis.__activateCodexHostFixture=twt;',
    '\n//# sourceMappingURL=extension.js.map\n',
  ].join('');
}

async function sourceTransform() {
  // @ts-expect-error Script modules are intentionally JavaScript-only.
  return import('../../scripts/lib/codex-provenance-source.mjs');
}

async function executePatchedFixture(
  source: string,
  provenanceCommand: (event: unknown) => Promise<unknown> = async () => undefined,
) {
  const provenanceCalls: unknown[] = [];
  const wrongNamespace = {
    commands: {
      executeCommand: () => {
        throw new Error('Used an unrelated VS Code import');
      },
    },
  };
  const vscode = {
    version: '1.101.0',
    commands: {
      executeCommand: (command: string, event?: unknown) => {
        if (command === 'codexExtensionHelper.internal.codexProvenance') {
          provenanceCalls.push(event);
          return provenanceCommand(event);
        }
        return Promise.resolve(undefined);
      },
    },
  };
  const namespaces = [wrongNamespace, wrongNamespace, vscode];
  const require = (specifier: string) => {
    if (specifier !== 'vscode') throw new Error(`Unexpected import: ${specifier}`);
    return {};
  };
  const U = () => namespaces.shift();
  const activate = new Function(
    'require',
    'U',
    `${source}\nreturn globalThis.__activateCodexHostFixture;`,
  )(require, U) as (context: unknown) => Promise<void>;
  const handlers: Array<(event: unknown) => void> = [];
  const subscriptions: unknown[] = [];
  const appServerClient = {
    registerInternalNotificationHandler(handler: (event: unknown) => void) {
      handlers.push(handler);
      return { dispose() {} };
    },
    takeCompletedTurnCwds() {
      return [];
    },
  };

  try {
    await activate({ subscriptions, appServerClient, extensionUri: {} });
    return { handlers, provenanceCalls, subscriptions };
  } finally {
    delete (globalThis as typeof globalThis & { __activateCodexHostFixture?: unknown })
      .__activateCodexHostFixture;
  }
}

describe('Codex provenance host source transform', () => {
  it('registers one bridge on the activation app-server client using the activation VS Code namespace', async () => {
    const {
      PROVENANCE_END_MARKER,
      PROVENANCE_START_MARKER,
      patchCodexHostSource,
    } = await sourceTransform();
    const original = minifiedHostFixture();

    const patched = patchCodexHostSource(original);
    const runtime = await executePatchedFixture(patched.source);

    expect(patched.status).toBe('patched');
    expect(runtime.handlers).toHaveLength(2);
    expect(runtime.subscriptions).toHaveLength(3);
    expect(patched.source.split(PROVENANCE_START_MARKER)).toHaveLength(2);
    expect(patched.source.split(PROVENANCE_END_MARKER)).toHaveLength(2);
    expect(patched.source.indexOf(PROVENANCE_END_MARKER) + PROVENANCE_END_MARKER.length).toBe(
      patched.source.indexOf(NOTIFICATION_ANCHOR),
    );
  });

  it('forwards patch updates and every file-change completion lifecycle without status filtering', async () => {
    const { patchCodexHostSource } = await sourceTransform();
    const runtime = await executePatchedFixture(patchCodexHostSource(minifiedHostFixture()).source);
    const injectedHandler = runtime.handlers[0];
    const forwarded = [
      { method: 'item/fileChange/patchUpdated', params: { itemId: 'patch' } },
      { method: 'item/completed', params: { item: { type: 'fileChange', status: 'completed' } } },
      { method: 'item/completed', params: { item: { type: 'fileChange', status: 'failed' } } },
      { method: 'item/completed', params: { item: { type: 'fileChange', status: 'declined' } } },
      { method: 'item/completed', params: { item: { type: 'fileChange', status: 'interrupted' } } },
      { method: 'item/completed', params: { item: { type: 'fileChange' } } },
    ];
    const ignored = [
      { method: 'item/completed', params: { item: { type: 'commandExecution', status: 'completed' } } },
      { method: 'turn/diff/updated', params: { diff: 'aggregate' } },
      { method: 'item/commandExecution/outputDelta', params: { delta: 'secret' } },
    ];

    for (const event of [...forwarded, ...ignored]) injectedHandler(event);
    await Promise.resolve();

    expect(runtime.provenanceCalls).toEqual(forwarded);
  });

  it('settles a rejected private command without an unhandled host promise', async () => {
    const { patchCodexHostSource } = await sourceTransform();
    const runtime = await executePatchedFixture(
      patchCodexHostSource(minifiedHostFixture()).source,
      async () => {
        throw new Error('command not found');
      },
    );

    expect(() => runtime.handlers[0]({
      method: 'item/fileChange/patchUpdated',
      params: { itemId: 'patch' },
    })).not.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.provenanceCalls).toHaveLength(1);
  });

  it('ignores unrelated internal notification handlers while selecting the activation handler', async () => {
    const { patchCodexHostSource } = await sourceTransform();
    const source = minifiedHostFixture().replace(
      ACTIVATION_HEADER,
      `const unrelated={push:()=>{}};const other={registerInternalNotificationHandler:()=>({})};unrelated.push(other.registerInternalNotificationHandler(ev=>{}));${ACTIVATION_HEADER}`,
    );

    const patched = patchCodexHostSource(source);
    const runtime = await executePatchedFixture(patched.source);

    expect(runtime.handlers).toHaveLength(2);
  });

  it('rejects an exact notification anchor moved outside the activation function body', async () => {
    const { patchCodexHostSource } = await sourceTransform();
    const source = minifiedHostFixture().replace(
      `${NOTIFICATION_ANCHOR}}globalThis`,
      `}${NOTIFICATION_ANCHOR}globalThis`,
    );

    expect(() => patchCodexHostSource(source))
      .toThrow(/inside the Codex activation function body/u);
  });

  it.each([
    ['direct property access', 'obj.return/2;'],
    ['optional property access', 'obj?.return/2;'],
  ])('does not let %s hide the real activation close', async (_name, propertyDivision) => {
    const { patchCodexHostSource } = await sourceTransform();
    const source = [
      'function enclosing(){',
      VSCODE_IMPORT,
      ACTIVATION_HEADER,
      propertyDivision,
      VSCODE_USAGE,
      '};',
      NOTIFICATION_ANCHOR,
      'const regexTrap=/[}]/u,stringTrap="}";',
      '}',
    ].join('');

    expect(() => new Function(source)).not.toThrow();
    expect(() => patchCodexHostSource(source))
      .toThrow(/inside the Codex activation function body/u);
  });

  it('distinguishes property keywords from real return and control keywords', async () => {
    const { patchCodexHostSource } = await sourceTransform();
    const tokenCases = 'const obj={return:4,throw:4,if:4};const quotient=obj.return/2+obj?.throw/2+obj?.if/2;function realReturn(){return /[}]/u}if(!1)/[}]/u.test("}");';
    const source = minifiedHostFixture().replace(
      NOTIFICATION_ANCHOR,
      `${tokenCases}${NOTIFICATION_ANCHOR}`,
    );

    const runtime = await executePatchedFixture(patchCodexHostSource(source).source);
    const event = { method: 'item/fileChange/patchUpdated', params: { itemId: 'patch' } };
    runtime.handlers[0](event);
    await Promise.resolve();

    expect(runtime.provenanceCalls).toEqual([event]);
  });

  it.each([
    ['if control flow', 'if(i)'],
    ['a label', 'bridgeLabel:'],
    ['a comma expression', 'void 0,'],
  ])('rejects a notification anchor attached to %s', async (_name, prefix) => {
    const { patchCodexHostSource } = await sourceTransform();
    const source = minifiedHostFixture().replace(
      NOTIFICATION_ANCHOR,
      `${prefix}${NOTIFICATION_ANCHOR}`,
    );

    expect(() => patchCodexHostSource(source))
      .toThrow(/standalone statement boundary/u);
  });

  it('finds the activation boundary across nested and lexical brace traps', async () => {
    const { patchCodexHostSource } = await sourceTransform();
    const lexicalTraps = 'const lexicalTraps={nested:{close:"}"}},stringTrap="}",templateTrap=`literal } ${{value:"{"}.value}`,regexTrap=/[{}]/u;/* } */ // }\n;';
    const source = minifiedHostFixture().replace(
      NOTIFICATION_ANCHOR,
      `${lexicalTraps}${NOTIFICATION_ANCHOR}`,
    );

    const runtime = await executePatchedFixture(patchCodexHostSource(source).source);
    const event = { method: 'item/fileChange/patchUpdated', params: { itemId: 'patch' } };
    runtime.handlers[0](event);
    await Promise.resolve();

    expect(runtime.provenanceCalls).toEqual([event]);
  });

  it('fails closed when the activation body cannot be lexically bounded', async () => {
    const { patchCodexHostSource } = await sourceTransform();
    const source = minifiedHostFixture().replace(
      NOTIFICATION_ANCHOR,
      `/* unclosed activation comment } ${NOTIFICATION_ANCHOR}`,
    );

    expect(() => patchCodexHostSource(source))
      .toThrow(/Could not establish the Codex activation function boundary.*block comment/u);
  });

  it('is exactly idempotent and restores the original bytes', async () => {
    const { patchCodexHostSource, unpatchCodexHostSource } = await sourceTransform();
    const original = minifiedHostFixture();
    const patched = patchCodexHostSource(original);

    expect(patchCodexHostSource(patched.source)).toEqual({
      status: 'already-patched',
      source: patched.source,
    });
    expect(unpatchCodexHostSource(patched.source)).toEqual({
      status: 'restored',
      source: original,
    });
    expect(unpatchCodexHostSource(original)).toEqual({
      status: 'not-patched',
      source: original,
    });
  });

  it.each([
    ['activation', (source: string) => source.replace(ACTIVATION_HEADER, '')],
    ['notification', (source: string) => source.replace(NOTIFICATION_ANCHOR, '')],
    ['VS Code usage', (source: string) => source.replace(VSCODE_USAGE, '')],
    ['VS Code import', (source: string) => source.replace(VSCODE_IMPORT, '')],
  ])('rejects a missing %s anchor', async (_name, mutate) => {
    const { patchCodexHostSource } = await sourceTransform();
    expect(() => patchCodexHostSource(mutate(minifiedHostFixture())))
      .toThrow(/Expected exactly one Codex provenance/u);
  });

  it.each([
    ['activation', (source: string) => `${source}${ACTIVATION_HEADER}`],
    ['notification', (source: string) => `${source}${NOTIFICATION_ANCHOR}`],
    ['VS Code usage', (source: string) => `${source}${VSCODE_USAGE}`],
    ['VS Code import', (source: string) => `${source}${VSCODE_IMPORT}`],
  ])('rejects a duplicate %s anchor', async (_name, mutate) => {
    const { patchCodexHostSource } = await sourceTransform();
    expect(() => patchCodexHostSource(mutate(minifiedHostFixture())))
      .toThrow(/Expected exactly one Codex provenance/u);
  });

  it.each([
    ['duplicate start', (start: string, end: string) => `${start}${start}${end}`],
    ['reversed', (start: string, end: string) => `${end}${start}`],
    ['start only', (start: string) => start],
    ['end only', (_start: string, end: string) => end],
  ])('rejects %s current marker state in both directions', async (_name, markers) => {
    const {
      PROVENANCE_END_MARKER,
      PROVENANCE_START_MARKER,
      patchCodexHostSource,
      unpatchCodexHostSource,
    } = await sourceTransform();
    const source = minifiedHostFixture() + markers(PROVENANCE_START_MARKER, PROVENANCE_END_MARKER);

    expect(() => patchCodexHostSource(source)).toThrow(/marker pair/u);
    expect(() => unpatchCodexHostSource(source)).toThrow(/marker pair/u);
  });

  it.each([
    ['unsupported version', '/* codex-extension-helper:provenance:start:v2 */', /unsupported.*v2/u],
    ['malformed kind', '/* codex-extension-helper:provenance:middle:v1 */', /malformed/u],
    ['malformed version', '/* codex-extension-helper:provenance:start:vnext */', /malformed/u],
  ])('rejects an %s marker', async (_name, marker, expected) => {
    const { patchCodexHostSource, unpatchCodexHostSource } = await sourceTransform();
    const source = minifiedHostFixture() + marker;

    expect(() => patchCodexHostSource(source)).toThrow(expected);
    expect(() => unpatchCodexHostSource(source)).toThrow(expected);
  });

  it('rejects a corrupted marked injection instead of accepting or deleting it', async () => {
    const { patchCodexHostSource, unpatchCodexHostSource } = await sourceTransform();
    const patched = patchCodexHostSource(minifiedHostFixture()).source;
    const corrupted = patched.replace(
      'codexExtensionHelper.internal.codexProvenance',
      'codexExtensionHelper.internal.untrusted',
    );

    expect(() => patchCodexHostSource(corrupted)).toThrow(/invalid Codex provenance bridge block/u);
    expect(() => unpatchCodexHostSource(corrupted)).toThrow(/invalid Codex provenance bridge block/u);
  });
});
