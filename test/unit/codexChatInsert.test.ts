import { describe, expect, it, vi } from 'vitest';
import {
  formatExplorerResourcesAsMentions,
  insertMentionsIntoCodex,
} from '../../src/codexChatInsert';

describe('Codex chat @ mention insertion', () => {
  it('formats files and directories as direct Codex mention attributes', () => {
    expect(formatExplorerResourcesAsMentions([
      { relativePath: 'CHANGELOG.md', fsPath: '/workspace/CHANGELOG.md', directory: false },
      { relativePath: 'scripts/lib', fsPath: '/workspace/scripts/lib', directory: true },
    ])).toEqual([
      { label: 'CHANGELOG.md', path: 'CHANGELOG.md', fsPath: '/workspace/CHANGELOG.md' },
      { label: 'lib', path: 'scripts/lib/', fsPath: '/workspace/scripts/lib' },
    ]);
  });

  it('normalizes Windows path separators without Markdown encoding', () => {
    expect(formatExplorerResourcesAsMentions([
      { relativePath: String.raw`docs\draft (old)`, fsPath: String.raw`C:\workspace\docs\draft (old)`, directory: true },
    ])).toEqual([{
      label: 'draft (old)',
      path: 'docs/draft (old)/',
      fsPath: String.raw`C:\workspace\docs\draft (old)`,
    }]);
  });

  it('focuses Codex and pastes one direct mention payload without opening the picker', async () => {
    const events: string[] = [];
    const dependencies = {
      openCodexSidebar: vi.fn(async () => {
        events.push('open-sidebar');
      }),
      waitForFocus: vi.fn(async () => {
        events.push('wait');
      }),
      copyPayload: vi.fn(async (payload: string) => {
        events.push(`copy:${payload}`);
      }),
      pastePayload: vi.fn(async () => {
        events.push('paste');
      }),
    };

    await insertMentionsIntoCodex([
      { label: 'CHANGELOG.md', path: 'CHANGELOG.md', fsPath: '/workspace/CHANGELOG.md' },
      { label: 'lib', path: 'scripts/lib/', fsPath: '/workspace/scripts/lib' },
    ], dependencies);

    expect(events).toEqual([
      'open-sidebar',
      'wait',
      'copy:codex-extension-helper:mentions:v1:[{"label":"CHANGELOG.md","path":"CHANGELOG.md","fsPath":"/workspace/CHANGELOG.md"},{"label":"lib","path":"scripts/lib/","fsPath":"/workspace/scripts/lib"}]',
      'paste',
    ]);
  });
});
