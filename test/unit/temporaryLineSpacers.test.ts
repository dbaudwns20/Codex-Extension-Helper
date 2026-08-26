import { describe, expect, it, vi } from 'vitest';
import { DisplayEditFence } from '../../src/displayEditFence';
import {
  createTemporaryLineSpacerPlan,
  TemporaryLineSpacerManager,
  type SpacerDocument,
  type SpacerTextEdit,
} from '../../src/temporaryLineSpacers';
import type { ChangeHunk } from '../../src/types';

function deletion(overrides: Partial<ChangeHunk> = {}): ChangeHunk {
  return {
    kind: 'deletion',
    originalStart: 1,
    originalEnd: 2,
    modifiedStart: 1,
    modifiedEnd: 1,
    originalLines: ['removed'],
    modifiedLines: [],
    ...overrides,
  };
}

describe('temporary line spacer planning', () => {
  it('maps a suffix deletion to the final blank row of an unterminated file', () => {
    const plan = createTemporaryLineSpacerPlan('keep', '\n', [deletion()]);

    expect(plan.displayText).toBe('keep\n');
    expect(plan.hunks[0].removedRows).toEqual([{ line: 1, text: 'removed' }]);
    expect(plan.hunks[0].actionLine).toBe(1);
  });
});

function managerFixture(initialText: string, initialDirty = false) {
  let document: SpacerDocument = {
    key: 'file:///review.ts',
    text: initialText,
    version: 1,
    isDirty: initialDirty,
    eol: '\n',
  };
  const apply = vi.fn(async (
    expected: SpacerDocument,
    _edits: readonly SpacerTextEdit[],
    expectedText: string,
  ) => {
    if (expected.version !== document.version || expected.text !== document.text) {
      return false;
    }
    document = {
      ...document,
      text: expectedText,
      version: document.version + 1,
      isDirty: true,
    };
    return true;
  });
  const manager = new TemporaryLineSpacerManager({
    document: () => document,
    apply,
    log: vi.fn(),
  }, new DisplayEditFence());
  return {
    manager,
    document: () => document,
    setDocument(text: string, version: number, isDirty: boolean) {
      document = { ...document, text, version, isDirty };
    },
  };
}

describe('TemporaryLineSpacerManager dirty provenance', () => {
  const request = {
    key: 'file:///review.ts',
    canonicalText: 'after\n',
    hunks: [deletion({
      kind: 'modification',
      originalStart: 0,
      modifiedStart: 0,
      modifiedEnd: 1,
      originalLines: ['before'],
      modifiedLines: ['after'],
    })],
  };

  it('reinstalls after removing its own spacer for a partial approval', async () => {
    const fixture = managerFixture(request.canonicalText);

    expect(await fixture.manager.install(request)).toBeDefined();
    expect((await fixture.manager.remove(request.key)).status).toBe('removed');
    expect(fixture.document()).toMatchObject({
      text: request.canonicalText,
      version: 3,
      isDirty: true,
    });

    expect(await fixture.manager.install(request)).toBeDefined();
    expect(fixture.document().text).toBe('\nafter\n');
  });

  it('reinstalls after an explicitly authorized dirty review edit', async () => {
    const fixture = managerFixture(request.canonicalText);
    expect(await fixture.manager.install(request)).toBeDefined();
    expect((await fixture.manager.remove(request.key)).status).toBe('removed');
    fixture.setDocument('AFTER\n', 4, true);

    fixture.manager.authorizeDirtyInstall(fixture.document());
    const nextRequest = {
      ...request,
      canonicalText: 'AFTER\n',
      hunks: [deletion({
        originalLines: ['after'],
        modifiedStart: 0,
        modifiedEnd: 1,
        modifiedLines: ['AFTER'],
      })],
    };

    expect(await fixture.manager.install(request)).toBeUndefined();
    expect(await fixture.manager.install(nextRequest)).toBeDefined();
    expect(fixture.document().text).toBe('\nAFTER\n');
  });

  it('rejects an arbitrary dirty document without trusted provenance', async () => {
    const fixture = managerFixture(request.canonicalText, true);

    expect(await fixture.manager.install(request)).toBeUndefined();
    expect(fixture.document().text).toBe(request.canonicalText);
  });
});
